/**
 * Turning a note's stored anchor into a line in the document as it stands now.
 *
 * Order matters, and it is not the order you might expect. The snippet is tried
 * before the symbol because it is more precise: a note written against line 128
 * of a forty-line function should stay on line 128, not slide up to the function
 * header. The symbol is the safety net for when the annotated line itself was
 * edited, which is exactly the case the snippet cannot survive.
 *
 *   1. snippet near its last known line   — precise, and cheap
 *   2. snippet anywhere in the file       — the code moved a long way
 *   3. enclosing symbol declaration       — the line changed, the function did not
 *   4. unanchored                         — surfaced in the sidebar, never deleted
 *
 * Steps 1 and 2 live in noteStore as pure functions; only step 3 needs VS Code.
 */

import * as vscode from 'vscode';
import { Note, SymbolOutline, findSymbolLine, resolveNoteLine } from './noteStore';

export class AnchorResolver {
  private readonly outlineCache = new Map<string, { version: number; outline: SymbolOutline[] }>();

  /**
   * Note path to 0-indexed line. A note that could not be placed is simply
   * absent — the caller treats a missing entry as unanchored, so there is no
   * second list to keep in step with this one.
   */
  async resolveAll(document: vscode.TextDocument, notes: Note[]): Promise<Map<string, number>> {
    const documentText = document.getText();
    const lines = new Map<string, number>();
    const needSymbolLookup: Note[] = [];

    for (const note of notes) {
      const snippetLine = resolveNoteLine(note, documentText);
      if (snippetLine !== undefined) lines.set(note.notePath, snippetLine);
      else if (note.symbol) needSymbolLookup.push(note);
    }

    // The symbol provider is only asked when something actually drifted, so the
    // common case — nothing moved — never pays for it.
    if (needSymbolLookup.length > 0) {
      const outline = await this.outlineFor(document);
      for (const note of needSymbolLookup) {
        const symbolLine = findSymbolLine(outline, note.symbol as string);
        if (symbolLine !== undefined) lines.set(note.notePath, symbolLine);
      }
    }

    return lines;
  }

  private async outlineFor(document: vscode.TextDocument): Promise<SymbolOutline[]> {
    const cacheKey = document.uri.toString();
    const cached = this.outlineCache.get(cacheKey);
    if (cached?.version === document.version) return cached.outline;

    const symbols = await vscode.commands.executeCommand<unknown[]>(
      'vscode.executeDocumentSymbolProvider',
      document.uri,
    );
    const outline = toOutline(symbols ?? []);

    // Earns its keep now that unresolved notes are retried on every redraw: a
    // file with an orphaned note would otherwise hit the symbol provider several
    // times a second while it is open.
    //
    // ponytail: unbounded map keyed by document URI. Documents are few and the
    // entries are small; evict on close if a session ever holds thousands.
    this.outlineCache.set(cacheKey, { version: document.version, outline });
    return outline;
  }
}

/**
 * Some providers return the flat SymbolInformation[] shape, which has no
 * `children` and no `selectionRange`. Those entries are dropped rather than
 * mishandled — the snippet tiers already covered the common cases.
 */
function toOutline(symbols: readonly unknown[]): SymbolOutline[] {
  return symbols.filter(isDocumentSymbol).map((symbol) => ({
    name: symbol.name,
    line: symbol.selectionRange.start.line,
    children: toOutline(symbol.children ?? []),
  }));
}

function isDocumentSymbol(symbol: unknown): symbol is vscode.DocumentSymbol {
  return (
    typeof symbol === 'object' &&
    symbol !== null &&
    'selectionRange' in symbol &&
    'children' in symbol
  );
}
