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

export interface ResolvedAnchors {
  /** Note path to 0-indexed line, for notes that could be placed. */
  lines: Map<string, number>;
  /** Note paths whose anchor is lost entirely. */
  unanchoredNotePaths: string[];
}

export class AnchorResolver {
  private readonly outlineCache = new Map<string, { version: number; outline: SymbolOutline[] }>();

  async resolveAll(document: vscode.TextDocument, notes: Note[]): Promise<ResolvedAnchors> {
    const documentText = document.getText();
    const lines = new Map<string, number>();
    const needSymbolLookup: Note[] = [];
    const unanchoredNotePaths: string[] = [];

    for (const note of notes) {
      const snippetLine = resolveNoteLine(note, documentText);
      if (snippetLine !== undefined) {
        lines.set(note.notePath, snippetLine);
      } else if (note.symbol) {
        needSymbolLookup.push(note);
      } else {
        unanchoredNotePaths.push(note.notePath);
      }
    }

    // The symbol provider is only asked when something actually drifted, so the
    // common case — nothing moved — never pays for it.
    if (needSymbolLookup.length > 0) {
      const outline = await this.outlineFor(document);
      for (const note of needSymbolLookup) {
        const symbolLine = findSymbolLine(outline, note.symbol as string);
        if (symbolLine === undefined) unanchoredNotePaths.push(note.notePath);
        else lines.set(note.notePath, symbolLine);
      }
    }

    return { lines, unanchoredNotePaths };
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
