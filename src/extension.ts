/**
 * Wiring only: read notes, register the sidebar, gutter rendering and commands,
 * then reload whenever anything under `.lore/` changes on disk.
 *
 * The watcher is what makes notes written by an AI agent appear without a
 * reload — the filesystem is the sync channel, so there is nothing to poll and
 * no cache to invalidate.
 */

import * as vscode from 'vscode';
import { createNote, openNote, revealNote } from './commands';
import { LORE_DIRECTORY, Note, readAllNotes } from './noteStore';
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

  const reloadNotes = async (): Promise<void> => {
    const notes = await readAllNotes(workspaceRoot);
    treeProvider.setNotes(notes);
    renderer.setNotes(notes);
    renderer.redraw();
  };

  const scheduledReload = debounce(() => void reloadNotes(), RELOAD_DEBOUNCE_MS);
  const scheduledRedraw = debounce(() => renderer.redraw(), REDRAW_DEBOUNCE_MS);

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
      renderer.redraw();
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => renderer.redraw(editors)),
    // Editing above a note moves it, so the pin has to follow the text.
    vscode.workspace.onDidChangeTextDocument(scheduledRedraw.run),

    vscode.commands.registerCommand('lore.new', () => createNote(workspaceRoot)),
    vscode.commands.registerCommand('lore.reveal', (note: Note) => revealNote(workspaceRoot, note)),
    vscode.commands.registerCommand('lore.openNote', (target?: LoreTreeItem | string) => {
      const notePath = notePathOf(target);
      return notePath === undefined ? undefined : openNote(notePath);
    }),
  );

  void reloadNotes();
}

export function deactivate(): void {
  // Nothing to tear down: every disposable is registered on context.subscriptions.
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
