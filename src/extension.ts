/**
 * Wiring only: read notes, register the sidebar and commands, and reload when
 * anything under `.lore/` changes on disk.
 *
 * The watcher is what makes notes written by an AI agent appear in the sidebar
 * without a reload — the filesystem is the sync channel, so there is nothing to
 * poll and no cache to invalidate.
 */

import * as vscode from 'vscode';
import { createNote, openNote, revealNote } from './commands';
import { LORE_DIRECTORY, Note, readAllNotes } from './noteStore';
import { LoreTreeItem, NoteTreeProvider } from './noteTree';

/** Enough to collapse the burst of events a `git pull` or agent write produces. */
const REFRESH_DEBOUNCE_MS = 100;

export function activate(context: vscode.ExtensionContext): void {
  // ponytail: first workspace folder only. Multi-root needs a note store per
  // folder; add it when someone actually opens Lore in a multi-root workspace.
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return;

  const treeProvider = new NoteTreeProvider(workspaceRoot);
  let refreshTimer: NodeJS.Timeout | undefined;

  const reloadNotes = async (): Promise<void> => {
    treeProvider.setNotes(await readAllNotes(workspaceRoot));
  };

  const scheduleReload = (): void => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void reloadNotes(), REFRESH_DEBOUNCE_MS);
  };

  const noteWatcher = vscode.workspace.createFileSystemWatcher(`**/${LORE_DIRECTORY}/**/*.md`);
  noteWatcher.onDidCreate(scheduleReload);
  noteWatcher.onDidChange(scheduleReload);
  noteWatcher.onDidDelete(scheduleReload);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('lore.notes', treeProvider),
    noteWatcher,
    // Only re-renders; the notes on disk have not changed.
    vscode.window.onDidChangeActiveTextEditor(() => treeProvider.refreshView()),
    vscode.commands.registerCommand('lore.new', () => createNote(workspaceRoot)),
    vscode.commands.registerCommand('lore.reveal', (note: Note) => revealNote(workspaceRoot, note)),
    vscode.commands.registerCommand('lore.openNote', (item?: LoreTreeItem) => {
      if (item && item.itemType === 'note') return openNote(item.note);
      return undefined;
    }),
    { dispose: () => refreshTimer && clearTimeout(refreshTimer) },
  );

  void reloadNotes();
}

export function deactivate(): void {
  // Nothing to tear down: every disposable is registered on context.subscriptions.
}
