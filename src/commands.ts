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
  moveNoteToScope,
  notesDirectory,
  readNote,
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

/**
 * Jump to the code a note annotates.
 *
 * `trackedLineIn` reports where the editor is currently drawing the note's
 * marker. It wins over re-resolving, because unsaved edits to the annotated line
 * defeat the stored snippet — without it, clicking a note warned that its code
 * had been deleted while its own marker sat correctly two lines away.
 */
export async function revealNote(
  workspaceRoot: string,
  note: Note | undefined,
  trackedLineIn: (document: vscode.TextDocument) => number | undefined = () => undefined,
): Promise<void> {
  // Reachable with nothing selected when run from the command palette.
  if (!note) {
    vscode.window.showInformationMessage('Lore: pick a note in the Lore sidebar to go to its code.');
    return;
  }

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
  const resolvedLine = trackedLineIn(document) ?? resolveNoteLine(note, document.getText());

  // Unlike the marker, which draws nothing where it cannot place a note, jumping
  // is best-effort: the last known line is still the most useful place to land.
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

/**
 * Point an existing note at the cursor, rewriting its anchor in place.
 *
 * This is the manual escape hatch for a note the resolver gave up on — a
 * rewritten function, a renamed class, code moved to another file. Anchors are
 * never rewritten automatically: guessing wrong would silently move a note onto
 * unrelated code, and for team notes it would churn the file on every save.
 */
export async function reattachNote(workspaceRoot: string, note: Note): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('Lore: put the cursor where the note belongs, then re-attach.');
    return;
  }

  const relativePath = path.relative(workspaceRoot, editor.document.uri.fsPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    vscode.window.showInformationMessage('Lore: notes can only be attached to files inside the workspace.');
    return;
  }

  const cursorLine = editor.selection.active.line;
  // targetPath is rewritten too, so a note can follow code that moved file.
  await writeNote({
    ...note,
    targetPath: toPosixPath(relativePath),
    symbol: await enclosingSymbolName(editor.document.uri, editor.selection.active),
    line: cursorLine + 1,
    snippet: editor.document.lineAt(cursorLine).text.trim() || undefined,
  });

  vscode.window.showInformationMessage(
    `Lore: "${note.title}" re-attached to ${toPosixPath(relativePath)}:${cursorLine + 1}`,
  );
}

/**
 * Promote a personal note to the team, moving it out of the gitignored
 * directory and into the one that travels with the repository.
 *
 * Confirmed first because it is the one action here that is hard to take back:
 * once the note is committed and pushed, it is in everyone's history.
 */
export async function shareNote(workspaceRoot: string, note: Note): Promise<void> {
  const confirmation = await vscode.window.showWarningMessage(
    `Share "${note.title}" with the team?`,
    { modal: true, detail: 'It moves into .lore/notes/, which is committed to git.' },
    'Share',
  );
  if (confirmation !== 'Share') return;

  await moveNoteToScope(workspaceRoot, note, 'team');
  vscode.window.showInformationMessage(`Lore: "${note.title}" is now a team note. Commit .lore/notes/ to share it.`);
}

/** Take a team note back to personal, out of git's reach for future commits. */
export async function unshareNote(workspaceRoot: string, note: Note): Promise<void> {
  await ensureLocalIgnored(workspaceRoot);
  await moveNoteToScope(workspaceRoot, note, 'personal');
  vscode.window.showInformationMessage(
    `Lore: "${note.title}" is personal again. Commit the deletion to remove it for others.`,
  );
}

/**
 * Bring a note's stored anchor back in line with the code it is now sitting on.
 *
 * Only safe because the caller tracked this note through the edits that moved
 * it — rewriting a *guessed* position would silently slide notes onto unrelated
 * code, which is why resolution never writes anything. Returns true when the
 * note file changed.
 */
export async function refreshAnchor(
  document: vscode.TextDocument,
  note: Note,
  line: number,
): Promise<boolean> {
  const safeLine = Math.min(Math.max(line, 0), Math.max(document.lineCount - 1, 0));
  const snippet = document.lineAt(safeLine).text.trim() || undefined;
  if (snippet === note.snippet && note.line === safeLine + 1) return false;

  // Re-read instead of trusting the caller's copy, which comes from a cache
  // refreshed on a debounce. Writing that copy back would revert a body edited
  // in the meantime — or recreate a note just deleted.
  const current = await readNote(note.notePath, note.scope);
  if (!current) return false;

  const symbol = await enclosingSymbolName(document.uri, new vscode.Position(safeLine, 0));

  await writeNote({
    ...current,
    line: safeLine + 1,
    snippet,
    // Keep the recorded symbol when no provider answered. A language server that
    // has not finished starting would otherwise delete the symbol anchor — the
    // one tier that survives edits to the annotated line.
    symbol: symbol ?? current.symbol,
  });
  return true;
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
