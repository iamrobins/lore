/**
 * The three things you can do with a note in this milestone: create one, jump to
 * the code it annotates, and open it for editing.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  Note,
  ensureLocalIgnored,
  isDirectoryNote,
  listNoteFileNames,
  notesDirectory,
  resolveNoteLine,
  toNoteFileName,
  toPosixPath,
  writeNote,
} from './noteStore';

/**
 * Create a personal note anchored to the cursor.
 *
 * Personal is the default because `.lore/local/` is gitignored: a half-formed
 * thought cannot reach the repo before you mean it to. Promoting a note to the
 * team is a later, deliberate action.
 */
export async function createNote(workspaceRoot: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('Lore: open a file to attach a note to it.');
    return;
  }

  const relativePath = path.relative(workspaceRoot, editor.document.uri.fsPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    vscode.window.showInformationMessage('Lore: notes can only be attached to files inside the workspace.');
    return;
  }

  const title = await vscode.window.showInputBox({
    prompt: 'Note title',
    placeHolder: 'Why this code is the way it is',
  });
  if (!title?.trim()) return; // dismissed, or nothing typed

  const cursorLine = editor.selection.active.line;
  const directory = notesDirectory(workspaceRoot, 'personal');
  const fileName = toNoteFileName(title, await listNoteFileNames(directory));

  const note: Note = {
    notePath: path.join(directory, fileName),
    targetPath: toPosixPath(relativePath),
    scope: 'personal',
    title: title.trim(),
    // The title lives as an H1 so the file reads correctly in any Markdown
    // editor, and so there is no second copy of it to drift out of sync.
    body: `# ${title.trim()}\n\n`,
    symbol: await enclosingSymbolName(editor.document.uri, editor.selection.active),
    line: cursorLine + 1,
    snippet: editor.document.lineAt(cursorLine).text.trim() || undefined,
    type: 'note',
    status: 'open',
    created: new Date().toISOString().slice(0, 10),
  };

  await ensureLocalIgnored(workspaceRoot);
  await writeNote(note);
  await openNote(note.notePath);
}

/** Jump to the code a note annotates, re-resolving the anchor on the way. */
export async function revealNote(workspaceRoot: string, note: Note): Promise<void> {
  // Folder and repo notes have no line to jump to, so open the note itself.
  if (isDirectoryNote(note)) {
    await openNote(note.notePath);
    return;
  }

  const targetUri = vscode.Uri.file(path.join(workspaceRoot, note.targetPath));
  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(targetUri);
  } catch {
    vscode.window.showWarningMessage(`Lore: ${note.targetPath} no longer exists.`);
    return;
  }

  // The stored line is only a hint — anything inserted above the note has moved
  // it. Trusting the stored number is the fastest way to feel broken.
  const lastLine = Math.max(document.lineCount - 1, 0);
  const resolvedLine = resolveNoteLine(note, document.getText());

  // Unlike the gutter, which hides a pin it cannot place, jumping is best-effort:
  // the last known line is still the most useful place to land.
  const line = Math.min(resolvedLine ?? (note.line ?? 1) - 1, lastLine);

  if (resolvedLine === undefined && note.snippet) {
    vscode.window.showWarningMessage(
      `Lore: the code for "${note.title}" moved or was deleted — showing its last known line.`,
    );
  }

  const editor = await vscode.window.showTextDocument(document);
  const targetRange = document.lineAt(line).range;
  editor.selection = new vscode.Selection(targetRange.start, targetRange.start);
  editor.revealRange(targetRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** Open a note's Markdown file, cursor parked at the end of the body. */
export async function openNote(notePath: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(notePath));
  const editor = await vscode.window.showTextDocument(document);

  const lastLine = Math.max(document.lineCount - 1, 0);
  const endOfDocument = document.lineAt(lastLine).range.end;
  editor.selection = new vscode.Selection(endOfDocument, endOfDocument);
}

/**
 * Dotted name of the innermost symbol containing the cursor, e.g.
 * `PaymentService.charge_customer`. Undefined is fine — `symbol` is optional,
 * and plenty of files have no symbol provider at all.
 */
async function enclosingSymbolName(
  uri: vscode.Uri,
  position: vscode.Position,
): Promise<string | undefined> {
  const symbols = await vscode.commands.executeCommand<unknown[]>(
    'vscode.executeDocumentSymbolProvider',
    uri,
  );
  if (!symbols?.length) return undefined;

  // Some providers return the flat SymbolInformation[] shape instead, which has
  // no `range` and would throw below.
  const documentSymbols = symbols.filter(isDocumentSymbol);
  return findEnclosingSymbol(documentSymbols, position, []);
}

function isDocumentSymbol(symbol: unknown): symbol is vscode.DocumentSymbol {
  return typeof symbol === 'object' && symbol !== null && 'range' in symbol && 'children' in symbol;
}

function findEnclosingSymbol(
  symbols: vscode.DocumentSymbol[],
  position: vscode.Position,
  ancestorNames: string[],
): string | undefined {
  for (const symbol of symbols) {
    if (!symbol.range.contains(position)) continue;

    const names = [...ancestorNames, symbol.name];
    // Prefer the innermost match; fall back to this symbol if no child contains it.
    return findEnclosingSymbol(symbol.children ?? [], position, names) ?? names.join('.');
  }
  return undefined;
}
