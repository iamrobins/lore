/**
 * Painting notes into the editor: a coloured label after the annotated line, a
 * mark on the overview ruler, and a Markdown hover.
 *
 * Deliberately NOT a gutter icon. VS Code renders `gutterIconPath` decorations
 * in the breakpoint column and they swallow the click, so an annotated line
 * becomes a line you cannot set a breakpoint on — and an interesting enough line
 * to annotate is usually one you want to break on too. The debugger owns the
 * gutter; notes live at the end of the line instead.
 *
 * Decoration and hover live together because they answer the same question —
 * which notes land on which line of this document right now — and that answer is
 * recomputed on every redraw rather than cached, so markers follow the code as
 * you type above them.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { AnchorResolver } from './anchorResolver';
import { LineEdit, LivePositions } from './livePositions';
import { Note, NoteScope, notesForFile, toPosixPath } from './noteStore';

const MAX_MARKER_TITLE_LENGTH = 60;

interface PlacedNote {
  note: Note;
  /** 0-indexed line in the document as it currently stands. */
  line: number;
}

export class NoteRenderer implements vscode.HoverProvider {
  private notes: Note[] = [];
  private unanchoredNotePaths = new Set<string>();
  private readonly resolver = new AnchorResolver();
  private readonly livePositions = new LivePositions();
  private readonly markers: Record<NoteScope, vscode.TextEditorDecorationType>;

  constructor(private readonly workspaceRoot: string) {
    this.markers = {
      personal: createMarkerDecoration('charts.green'),
      team: createMarkerDecoration('charts.blue'),
    };
  }

  setNotes(notes: Note[]): void {
    this.notes = notes;
  }

  /**
   * Move tracked notes with the text. Called on every keystroke rather than
   * debounced — a dropped edit would silently misplace a note.
   */
  trackEdit(event: vscode.TextDocumentChangeEvent): void {
    this.livePositions.applyEdits(
      event.document.uri.toString(),
      event.contentChanges.map(toLineEdit),
    );
  }

  /** Where a note currently sits in an open document, if it is being tracked. */
  trackedLine(document: vscode.TextDocument, notePath: string): number | undefined {
    return this.livePositions.linesFor(document.uri.toString()).get(notePath);
  }

  forgetDocument(document: vscode.TextDocument): void {
    this.livePositions.forgetDocument(document.uri.toString());
  }

  /** After a note is re-attached by hand, every tracked line may be stale. */
  forgetTrackedPositions(): void {
    this.livePositions.forgetAll();
  }

  /**
   * Notes in the open editors whose anchor could not be resolved. Only files
   * that are actually open can be checked — the sidebar labels these rather than
   * pretending to know about every file in the workspace.
   */
  getUnanchoredNotePaths(): Set<string> {
    return this.unanchoredNotePaths;
  }

  /** Repaint markers for the given editors, defaulting to everything visible. */
  async redraw(
    editors: readonly vscode.TextEditor[] = vscode.window.visibleTextEditors,
  ): Promise<void> {
    const unanchoredNotePaths = new Set<string>();

    for (const editor of editors) {
      const { placed, unanchored } = await this.placeNotes(editor.document);
      for (const notePath of unanchored) unanchoredNotePaths.add(notePath);

      for (const scope of ['personal', 'team'] as const) {
        const decorations: vscode.DecorationOptions[] = placed
          .filter((entry) => entry.note.scope === scope)
          .map((entry) => ({
            range: editor.document.lineAt(entry.line).range,
            // Per-note text, so it has to be set on the range rather than the type.
            renderOptions: { after: { contentText: markerLabel(entry.note) } },
          }));
        editor.setDecorations(this.markers[scope], decorations);
      }
    }

    this.unanchoredNotePaths = unanchoredNotePaths;
  }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    const { placed } = await this.placeNotes(document);
    const notesOnLine = placed.filter((entry) => entry.line === position.line);
    if (notesOnLine.length === 0) return undefined;

    const markdown = new vscode.MarkdownString(
      notesOnLine.map((entry) => renderNote(entry.note)).join('\n\n---\n\n'),
    );
    // Required for the `command:` links that open and re-attach the note.
    markdown.isTrusted = true;

    return new vscode.Hover(markdown, document.lineAt(position.line).range);
  }

  dispose(): void {
    for (const decoration of Object.values(this.markers)) decoration.dispose();
  }

  private async placeNotes(
    document: vscode.TextDocument,
  ): Promise<{ placed: PlacedNote[]; unanchored: string[] }> {
    const relativePath = path.relative(this.workspaceRoot, document.uri.fsPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return { placed: [], unanchored: [] };
    }

    const fileNotes = notesForFile(this.notes, toPosixPath(relativePath));
    // Checked before any resolution so hovering in an unannotated file is free.
    if (fileNotes.length === 0) return { placed: [], unanchored: [] };

    // Anything already tracked keeps its live line; only notes we have never
    // placed in this document go through snippet and symbol resolution.
    const trackedLines = this.livePositions.linesFor(document.uri.toString());
    const untrackedNotes = fileNotes.filter((note) => !trackedLines.has(note.notePath));

    if (untrackedNotes.length > 0) {
      const { lines } = await this.resolver.resolveAll(document, untrackedNotes);
      for (const note of untrackedNotes) trackedLines.set(note.notePath, lines.get(note.notePath));
    }

    const lastLine = Math.max(document.lineCount - 1, 0);
    const placed: PlacedNote[] = [];
    const unanchored: string[] = [];

    for (const note of fileNotes) {
      const line = trackedLines.get(note.notePath);
      if (line === undefined) unanchored.push(note.notePath);
      else placed.push({ note, line: Math.min(line, lastLine) });
    }

    return { placed, unanchored };
  }
}

function toLineEdit(change: vscode.TextDocumentContentChangeEvent): LineEdit {
  return {
    startLine: change.range.start.line,
    startCharacter: change.range.start.character,
    endLine: change.range.end.line,
    addedLineCount: countNewlines(change.text),
  };
}

function countNewlines(text: string): number {
  let count = 0;
  for (const character of text) if (character === '\n') count += 1;
  return count;
}

function createMarkerDecoration(colorId: string): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor(colorId),
      fontStyle: 'italic',
      margin: '0 0 0 2rem',
    },
    // The ruler is a separate lane from the gutter, so it costs the debugger nothing.
    overviewRulerColor: new vscode.ThemeColor(colorId),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
}

/** Enough of the note to recognise it without hovering, short enough to ignore. */
function markerLabel(note: Note): string {
  const title =
    note.title.length > MAX_MARKER_TITLE_LENGTH
      ? `${note.title.slice(0, MAX_MARKER_TITLE_LENGTH).trimEnd()}…`
      : note.title;
  return `● ${title}`;
}

function renderNote(note: Note): string {
  // The body already opens with the title as an H1, so it is rendered as-is
  // rather than repeating the title above it.
  const commandArguments = encodeURIComponent(JSON.stringify([note.notePath]));
  const scopeLabel = note.scope === 'personal' ? '🟢 Personal' : '🔵 Team';
  const typeLabel = note.type === 'note' ? '' : ` · ${note.type}`;

  return [
    note.body || '_Empty note_',
    '',
    `${scopeLabel}${typeLabel} · [Open note](command:lore.openNote?${commandArguments})`,
  ].join('\n');
}
