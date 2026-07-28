/**
 * Wiring only: read notes, register the sidebar, editor rendering and commands,
 * then reload whenever anything under `.lore/` changes on disk.
 *
 * The watcher is what makes notes written by an AI agent appear without a
 * reload — the filesystem is the sync channel, so there is nothing to poll and
 * no cache to invalidate.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  createNote,
  openNote,
  reattachNote,
  refreshAnchor,
  revealNote,
  shareNote,
  unshareNote,
} from './commands';
import { LORE_DIRECTORY, Note, notesForFile, readAllNotes, toPosixPath } from './noteStore';
import { NoteRenderer } from './noteRenderer';
import { LoreTreeItem, NoteTreeProvider } from './noteTree';

/** Enough to collapse the burst of events a `git pull` or agent write produces. */
const RELOAD_DEBOUNCE_MS = 100;

/** Long enough that typing does not repaint on every keystroke. */
const REDRAW_DEBOUNCE_MS = 150;

export function activate(context: vscode.ExtensionContext): void {
  // ponytail: first workspace folder only. Multi-root needs a note store per
  // folder; add it when someone actually opens Lore in a multi-root workspace.
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return;

  const treeProvider = new NoteTreeProvider(workspaceRoot);
  const renderer = new NoteRenderer(workspaceRoot);
  let currentNotes: Note[] = [];

  // Repainting is what discovers orphans, so the sidebar is told after each pass.
  const redraw = async (editors?: readonly vscode.TextEditor[]): Promise<void> => {
    await renderer.redraw(editors);
    treeProvider.setUnanchoredNotePaths(renderer.getUnanchoredNotePaths());
  };

  const reloadNotes = async (): Promise<void> => {
    currentNotes = await readAllNotes(workspaceRoot);
    treeProvider.setNotes(currentNotes);
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

    const relativePath = path.relative(workspaceRoot, document.uri.fsPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return;

    for (const note of notesForFile(currentNotes, toPosixPath(relativePath))) {
      const line = renderer.trackedLine(document, note.notePath);
      if (line !== undefined) await refreshAnchor(document, note, line);
    }
  };

  const noteWatcher = vscode.workspace.createFileSystemWatcher(`**/${LORE_DIRECTORY}/**/*.md`);
  noteWatcher.onDidCreate(scheduledReload.run);
  noteWatcher.onDidChange(scheduledReload.run);
  noteWatcher.onDidDelete(scheduledReload.run);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('lore.notes', treeProvider),
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

    vscode.commands.registerCommand('lore.new', () => createNote(workspaceRoot)),
    vscode.commands.registerCommand('lore.reveal', (note: Note) => revealNote(workspaceRoot, note)),
    vscode.commands.registerCommand('lore.reattach', async (item?: LoreTreeItem) => {
      if (item?.itemType !== 'note') return;
      await reattachNote(workspaceRoot, item.note);
      // Every tracked line was based on the old anchor.
      renderer.forgetTrackedPositions();
    }),
    vscode.commands.registerCommand('lore.openNote', (target?: LoreTreeItem | string) => {
      const notePath = notePathOf(target);
      return notePath === undefined ? undefined : openNote(notePath);
    }),
    // Sharing changes the note's path, so anything tracked under the old one
    // has to be dropped and resolved again.
    vscode.commands.registerCommand('lore.share', async (item?: LoreTreeItem) => {
      if (item?.itemType !== 'note') return;
      await shareNote(workspaceRoot, item.note);
      renderer.forgetTrackedPositions();
    }),
    vscode.commands.registerCommand('lore.unshare', async (item?: LoreTreeItem) => {
      if (item?.itemType !== 'note') return;
      await unshareNote(workspaceRoot, item.note);
      renderer.forgetTrackedPositions();
    }),
  );

  void reloadNotes();
}

export function deactivate(): void {
  // Nothing to tear down: every disposable is registered on context.subscriptions.
}

/** Note files are not annotation targets, so saving one must not rewrite anchors. */
function isInsideLoreDirectory(filePath: string): boolean {
  return toPosixPath(filePath).includes(`/${LORE_DIRECTORY}/`);
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
