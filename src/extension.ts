/**
 * Wiring only: find every Lore project in the workspace, read their notes,
 * register the sidebar, editor rendering and commands, then reload whenever
 * anything under a `.lore/` changes on disk.
 *
 * The watcher is what makes notes written by an AI agent appear without a
 * reload — the filesystem is the sync channel, so there is nothing to poll and
 * no cache to invalidate.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  createNote,
  deleteNote,
  openNote,
  reattachNote,
  refreshAnchor,
  revealNote,
  shareNote,
  unshareNote,
} from './commands';
import {
  LORE_DIRECTORY,
  Note,
  notesForAbsolutePath,
  readAllNotes,
  rootContaining,
  toPosixPath,
} from './noteStore';
import { NoteRenderer } from './noteRenderer';
import { LoreTreeItem, NoteTreeProvider } from './noteTree';

/** Enough to collapse the burst of events a `git pull` or agent write produces. */
const RELOAD_DEBOUNCE_MS = 100;

/** Long enough that typing does not repaint on every keystroke. */
const REDRAW_DEBOUNCE_MS = 150;

export function activate(context: vscode.ExtensionContext): void {
  const treeProvider = new NoteTreeProvider();
  const renderer = new NoteRenderer();
  let currentNotes: Note[] = [];
  let roots: string[] = [];

  /** The project a file belongs to, for commands that need one before any note exists. */
  const projectRootFor = (uri: vscode.Uri): string | undefined =>
    rootContaining(roots, uri.fsPath) ?? vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;

  // Repainting is what discovers orphans, so the sidebar is told after each pass.
  const redraw = async (editors?: readonly vscode.TextEditor[]): Promise<void> => {
    await renderer.redraw(editors);
    treeProvider.setUnanchoredNotePaths(renderer.getUnanchoredNotePaths());
  };

  const reloadNotes = async (): Promise<void> => {
    const previousNotes = new Map(currentNotes.map((note) => [note.notePath, note]));
    // Re-discovered every time rather than cached: a `.lore/` appears the moment
    // someone runs `git pull`, clones a package, or writes their first note.
    roots = await findLoreRoots();
    currentNotes = (await Promise.all(roots.map((root) => readAllNotes(root)))).flat();

    // A tracked line outlives the anchor it came from unless it is dropped here.
    // Without this, hand-editing a note's `line:` had no effect and was then
    // reverted by the next save, and a new note that slugged to a deleted note's
    // filename inherited its position.
    for (const note of currentNotes) {
      const before = previousNotes.get(note.notePath);
      if (!before || anchorChanged(before, note)) renderer.forgetNote(note.notePath);
      previousNotes.delete(note.notePath);
    }
    for (const deletedNotePath of previousNotes.keys()) renderer.forgetNote(deletedNotePath);

    treeProvider.setNotes(currentNotes, roots);
    renderer.setNotes(currentNotes);
    await redraw();
  };

  const scheduledReload = debounce(() => void reloadNotes(), RELOAD_DEBOUNCE_MS);
  const scheduledRedraw = debounce(() => void redraw(), REDRAW_DEBOUNCE_MS);

  /**
   * Once the file is saved, write the notes' anchors back to match the code they
   * are now on. The tracked line is what makes this safe — see refreshAnchor.
   * The watcher picks the rewritten notes up, so nothing reloads explicitly here.
   */
  const refreshAnchorsIn = async (document: vscode.TextDocument): Promise<void> => {
    if (isInsideLoreDirectory(document.uri.fsPath)) return;

    for (const note of notesForAbsolutePath(currentNotes, document.uri.fsPath)) {
      const line = renderer.trackedLine(document, note.notePath);
      if (line !== undefined) await refreshAnchor(document, note, line);
    }
  };

  const noteWatcher = vscode.workspace.createFileSystemWatcher(`**/${LORE_DIRECTORY}/**/*.md`);
  noteWatcher.onDidCreate(scheduledReload.run);
  noteWatcher.onDidChange(scheduledReload.run);
  noteWatcher.onDidDelete(scheduledReload.run);

  // createTreeView rather than registerTreeDataProvider, for the visibility
  // event: opening the sidebar is the moment you expect to be looking at what is
  // on disk right now, and a watcher can miss writes on a network or remote
  // filesystem — which is exactly where an agent on another machine writes them.
  const treeView = vscode.window.createTreeView('lore.notes', { treeDataProvider: treeProvider });

  context.subscriptions.push(
    treeView,
    treeView.onDidChangeVisibility((event) => {
      if (event.visible) scheduledReload.run();
    }),
    vscode.languages.registerHoverProvider({ scheme: 'file' }, renderer),
    noteWatcher,
    renderer,
    scheduledReload,
    scheduledRedraw,

    // The notes on disk have not changed here — only what is on screen.
    vscode.window.onDidChangeActiveTextEditor(() => {
      treeProvider.refreshView();
      void redraw();
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => void redraw(editors)),

    // Tracking runs on every keystroke; only the repaint is debounced. A dropped
    // edit would misplace a note, whereas a late repaint just looks slow.
    vscode.workspace.onDidChangeTextDocument((event) => {
      renderer.trackEdit(event);
      scheduledRedraw.run();
    }),
    vscode.workspace.onDidSaveTextDocument((document) => void refreshAnchorsIn(document)),
    vscode.workspace.onDidCloseTextDocument((document) => renderer.forgetDocument(document)),

    // Adding or removing a folder changes which projects exist.
    vscode.workspace.onDidChangeWorkspaceFolders(scheduledReload.run),

    vscode.commands.registerCommand(
      'lore.new',
      reporting(async () => {
        const editor = vscode.window.activeTextEditor;
        await createNote(editor && projectRootFor(editor.document.uri));
        // The watcher sees the new file too; this is what makes a note appear
        // even when it landed somewhere the watcher does not reach, and it is
        // also what discovers a project whose first note has just been written.
        scheduledReload.run();
      }),
    ),
    vscode.commands.registerCommand(
      'lore.reveal',
      reporting((note?: Note) =>
        revealNote(note, (document) =>
          note ? renderer.trackedLine(document, note.notePath) : undefined,
        ),
      ),
    ),
    vscode.commands.registerCommand(
      'lore.reattach',
      reporting(async (item?: LoreTreeItem) => {
        if (item?.itemType !== 'note') return;
        await reattachNote(item.note);
        // Every tracked line was based on the old anchor.
        renderer.forgetTrackedPositions();
        scheduledReload.run();
      }),
    ),
    vscode.commands.registerCommand(
      'lore.openNote',
      reporting(async (target?: LoreTreeItem | string) => {
        const notePath = notePathOf(target);
        if (notePath !== undefined) await openNote(notePath);
      }),
    ),
    // Sharing changes the note's path, so anything tracked under the old one
    // has to be dropped and resolved again.
    vscode.commands.registerCommand(
      'lore.share',
      reporting(async (item?: LoreTreeItem) => {
        if (item?.itemType !== 'note') return;
        await shareNote(item.note);
        renderer.forgetTrackedPositions();
        scheduledReload.run();
      }),
    ),
    vscode.commands.registerCommand(
      'lore.unshare',
      reporting(async (item?: LoreTreeItem) => {
        if (item?.itemType !== 'note') return;
        await unshareNote(item.note);
        renderer.forgetTrackedPositions();
        scheduledReload.run();
      }),
    ),
    vscode.commands.registerCommand(
      'lore.delete',
      reporting(async (item?: LoreTreeItem) => {
        if (item?.itemType !== 'note') return;
        await deleteNote(item.note);
        renderer.forgetNote(item.note.notePath);
        // The watcher will notice too, but a deleted note should leave the
        // sidebar the moment you confirm, not whenever the filesystem says so.
        scheduledReload.run();
      }),
    ),
  );

  void reloadNotes();
}

export function deactivate(): void {
  // Nothing to tear down: every disposable is registered on context.subscriptions.
}

/**
 * Every Lore project in the workspace: the directory above each `.lore/` that
 * holds notes, at any depth. A monorepo keeps one per package and a multi-root
 * workspace one per repository, and both were invisible when only the first
 * workspace folder was read.
 *
 * Found from the note files rather than by walking directories ourselves, so
 * the search runs in VS Code's indexer. The exclude is given explicitly: left
 * to the default, a user who hides `.lore` from their explorer would silently
 * lose every note in the sidebar.
 */
async function findLoreRoots(): Promise<string[]> {
  const noteFiles = await vscode.workspace.findFiles(
    `**/${LORE_DIRECTORY}/{local,notes}/*.md`,
    '**/node_modules/**',
  );

  const roots = new Set(
    noteFiles.map((file) => path.resolve(path.dirname(file.fsPath), '..', '..')),
  );
  return [...roots].sort();
}

/** Note files are not annotation targets, so saving one must not rewrite anchors. */
function isInsideLoreDirectory(filePath: string): boolean {
  return toPosixPath(filePath).includes(`/${LORE_DIRECTORY}/`);
}

/** Whether a note now points somewhere different from the copy we were holding. */
function anchorChanged(before: Note, after: Note): boolean {
  return (
    before.line !== after.line ||
    before.snippet !== after.snippet ||
    before.symbol !== after.symbol ||
    before.targetPath !== after.targetPath
  );
}

/**
 * Run a command, reporting failure. Writing a note can fail for ordinary reasons
 * — a read-only file, a file held open by another process — and without this the
 * user is told nothing while their note goes unsaved.
 */
function reporting<T extends unknown[]>(
  action: (...args: T) => Promise<void>,
): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      await action(...args);
    } catch (error) {
      vscode.window.showErrorMessage(`Lore: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

/** The sidebar button passes a tree item; the hover link passes a path. */
function notePathOf(target?: LoreTreeItem | string): string | undefined {
  if (typeof target === 'string') return target;
  if (target?.itemType === 'note') return target.note.notePath;
  return undefined;
}

function debounce(action: () => void, delayMs: number): { run: () => void; dispose: () => void } {
  let timer: NodeJS.Timeout | undefined;
  return {
    run: () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(action, delayMs);
    },
    dispose: () => {
      if (timer) clearTimeout(timer);
    },
  };
}
