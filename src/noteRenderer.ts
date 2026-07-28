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
 * recomputed from the snippet on every redraw rather than cached, so markers
 * follow the code as you type above them.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { Note, NoteScope, notesForFile, resolveNoteLine, toPosixPath } from './noteStore';

const MAX_MARKER_TITLE_LENGTH = 60;

interface PlacedNote {
  note: Note;
  /** 0-indexed line in the document as it currently stands. */
  line: number;
}

export class NoteRenderer implements vscode.HoverProvider {
  private notes: Note[] = [];
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

  /** Repaint markers for the given editors, defaulting to everything visible. */
  redraw(editors: readonly vscode.TextEditor[] = vscode.window.visibleTextEditors): void {
    for (const editor of editors) {
      const placedNotes = this.placeNotes(editor.document);

      for (const scope of ['personal', 'team'] as const) {
        const decorations: vscode.DecorationOptions[] = placedNotes
          .filter((placed) => placed.note.scope === scope)
          .map((placed) => ({
            range: editor.document.lineAt(placed.line).range,
            // Per-note text, so it has to be set on the range rather than the type.
            renderOptions: { after: { contentText: markerLabel(placed.note) } },
          }));
        editor.setDecorations(this.markers[scope], decorations);
      }
    }
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const notesOnLine = this.placeNotes(document).filter((placed) => placed.line === position.line);
    if (notesOnLine.length === 0) return undefined;

    const markdown = new vscode.MarkdownString(
      notesOnLine.map((placed) => renderNote(placed.note)).join('\n\n---\n\n'),
    );
    // Required for the `command:` link that opens the note for editing.
    markdown.isTrusted = true;

    return new vscode.Hover(markdown, document.lineAt(position.line).range);
  }

  dispose(): void {
    for (const decoration of Object.values(this.markers)) decoration.dispose();
  }

  /**
   * ponytail: re-resolves every note in the file on each redraw. Fine for the
   * handful of notes a file collects; if a file ever holds hundreds, cache per
   * document version instead.
   */
  private placeNotes(document: vscode.TextDocument): PlacedNote[] {
    const relativePath = path.relative(this.workspaceRoot, document.uri.fsPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return [];

    const fileNotes = notesForFile(this.notes, toPosixPath(relativePath));
    // Checked before reading the text so hovering in an unannotated file is free.
    if (fileNotes.length === 0) return [];

    const documentText = document.getText();
    const lastLine = Math.max(document.lineCount - 1, 0);

    return fileNotes.flatMap((note) => {
      const line = resolveNoteLine(note, documentText);
      if (line === undefined) return [];
      return [{ note, line: Math.min(line, lastLine) }];
    });
  }
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
  const title = note.title.length > MAX_MARKER_TITLE_LENGTH
    ? `${note.title.slice(0, MAX_MARKER_TITLE_LENGTH).trimEnd()}…`
    : note.title;
  return `● ${title}`;
}

function renderNote(note: Note): string {
  // The body already opens with the title as an H1, so it is rendered as-is
  // rather than repeating the title above it.
  const openNoteArguments = encodeURIComponent(JSON.stringify([note.notePath]));
  const scopeLabel = note.scope === 'personal' ? '🟢 Personal' : '🔵 Team';
  const typeLabel = note.type === 'note' ? '' : ` · ${note.type}`;

  return [
    note.body || '_Empty note_',
    '',
    `${scopeLabel}${typeLabel} · [Open note](command:lore.openNote?${openNoteArguments})`,
  ].join('\n');
}
