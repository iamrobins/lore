/**
 * Where notes actually sit in an open document, tracked through edits.
 *
 * Resolving a note from its snippet is right when a file is first opened, and
 * wrong while you are typing in it: the moment you edit the annotated line, the
 * snippet stops matching and the note detaches — even though the edit is the
 * clearest possible signal that the note belongs to that line.
 *
 * So an open document keeps a live line per note, shifted by the edits VS Code
 * reports. Snippet and symbol resolution only runs for notes not yet tracked.
 * This is how breakpoints behave, which is the model the whole feature borrows.
 *
 * No vscode import: the shifting arithmetic is the part that can be wrong, so it
 * stays testable. Callers convert content-change events into LineEdit.
 */

/** One content change, reduced to what moving a line anchor actually needs. */
export interface LineEdit {
  /** 0-indexed first line of the replaced range. */
  startLine: number;
  startCharacter: number;
  /** 0-indexed last line of the replaced range. */
  endLine: number;
  /** Newlines in the replacement text. */
  addedLineCount: number;
}

/** Where a tracked line ends up after one edit. */
export function shiftLine(line: number, edit: LineEdit): number {
  const removedLineCount = edit.endLine - edit.startLine;
  const delta = edit.addedLineCount - removedLineCount;

  if (line < edit.startLine) return line;
  if (line > edit.endLine) return line + delta;

  // The edit landed on the tracked line itself. Keeping the note attached here
  // is the entire point of this module.
  //
  // `endLine === startLine` is load-bearing: it restricts this branch to an edit
  // confined to the tracked line, which can only have pushed its content down.
  // Without it, a replacement that *consumed* the tracked line — format-on-save,
  // or select-lines-and-paste — also matched, and then added the replacement's
  // height on top, walking the note off the end of the new text.
  //
  // ponytail: notes anchor to lines, not columns, so a split is judged by
  // whether the edit started at column zero. Track columns if this ever misplaces
  // a note in practice.
  if (
    line === edit.startLine &&
    edit.endLine === edit.startLine &&
    edit.startCharacter === 0 &&
    edit.addedLineCount > 0
  ) {
    // Text was pushed down from the start of the line, so the content moved too.
    return line + edit.addedLineCount;
  }
  return Math.min(line, edit.startLine + edit.addedLineCount);
}

/**
 * VS Code reports changes as a sequence, each computed against the state left by
 * the previous one, so they apply in order.
 */
export function shiftLineThrough(line: number, edits: readonly LineEdit[]): number {
  return edits.reduce(shiftLine, line);
}

export class LivePositions {
  /**
   * Document key to note path to line. Only notes that were successfully placed
   * appear: a failure is never recorded, so a note whose code shows up later —
   * a paste, a slow language server, a `git pull` — is retried on the next
   * redraw instead of being stuck as "anchor lost" until the file is closed.
   */
  private readonly byDocument = new Map<string, Map<string, number>>();

  /** Tracked lines for a document, created empty on first use. */
  linesFor(documentKey: string): Map<string, number> {
    const existing = this.byDocument.get(documentKey);
    if (existing) return existing;

    const created = new Map<string, number>();
    this.byDocument.set(documentKey, created);
    return created;
  }

  /** Tracked lines for a document without creating an entry for it. */
  peek(documentKey: string): Map<string, number> | undefined {
    return this.byDocument.get(documentKey);
  }

  applyEdits(documentKey: string, edits: readonly LineEdit[]): void {
    const lines = this.byDocument.get(documentKey);
    if (!lines || edits.length === 0) return;

    for (const [notePath, line] of lines) {
      lines.set(notePath, shiftLineThrough(line, edits));
    }
  }

  /**
   * Stop tracking one note everywhere. Used when its anchor changed on disk, or
   * it was deleted — a surviving entry would pin it to the old line, and worse,
   * a new note that slugs to the same filename would inherit that position.
   */
  forgetNote(notePath: string): void {
    for (const lines of this.byDocument.values()) lines.delete(notePath);
  }

  /** Drop a document's tracking, so its notes resolve afresh when reopened. */
  forgetDocument(documentKey: string): void {
    this.byDocument.delete(documentKey);
  }

  /** Drop everything, after an explicit re-anchoring makes tracked lines stale. */
  forgetAll(): void {
    this.byDocument.clear();
  }
}
