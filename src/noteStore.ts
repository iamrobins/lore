/**
 * Reading, writing, and interpreting `.lore/` notes.
 *
 * This module deliberately does NOT import `vscode`. It depends only on Node's
 * standard library and `gray-matter`, which means:
 *   - its logic is testable with `node --test`, no extension host required
 *   - it can be reused verbatim by the MCP server that exposes notes to AI agents
 *
 * Keep VS Code API calls in extension.ts, noteTree.ts, and commands.ts.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import matter from 'gray-matter';

export type NoteScope = 'personal' | 'team';
export type NoteType = 'note' | 'ai-instruction' | 'warning' | 'todo' | 'doc';
export type NoteStatus = 'open' | 'resolved';

const NOTE_TYPES: readonly NoteType[] = ['note', 'ai-instruction', 'warning', 'todo', 'doc'];

/** Root of the note store, relative to the workspace. */
export const LORE_DIRECTORY = '.lore';

/** Written with forward slashes because .gitignore never uses backslashes. */
export const LOCAL_IGNORE_ENTRY = '.lore/local/';

/** How far from the last known line to search before scanning the whole file. */
const SNIPPET_SEARCH_RADIUS = 50;

/** Longest slug we will generate from a note title. */
const MAX_SLUG_LENGTH = 60;

export interface Note {
  /** Absolute path of the `.md` file that holds this note. */
  notePath: string;
  /** Workspace-relative path of the code this note annotates, POSIX separators. */
  targetPath: string;
  /** Derived from which directory the note lives in — never stored in frontmatter. */
  scope: NoteScope;
  title: string;
  body: string;
  symbol?: string;
  /** 1-indexed, matching what editors and humans display. */
  line?: number;
  snippet?: string;
  type: NoteType;
  status: NoteStatus;
  author?: string;
  created?: string;
  /**
   * Frontmatter keys this tool does not know about, carried through unchanged.
   * Notes are hand-editable, and rewriting an anchor must not silently delete
   * someone's `ticket:` or `tags:`.
   */
  extra?: Record<string, unknown>;
}

const KNOWN_FRONTMATTER_KEYS = new Set([
  'path',
  'symbol',
  'line',
  'snippet',
  'type',
  'status',
  'author',
  'created',
]);

/**
 * A workspace-relative POSIX path, or undefined when the target lies outside the
 * workspace. Accepts absolute paths, `./` prefixes and backslashes, because the
 * MCP tools take this straight from an AI agent — and agents hold absolute paths,
 * since that is what Claude Code's own Read and Edit tools require.
 *
 * A trailing slash is preserved: it is what distinguishes a folder note from a
 * file note.
 */
export function workspaceRelativePath(
  workspaceRoot: string,
  targetPath: string,
): string | undefined {
  const trimmed = targetPath.trim();
  if (trimmed === '') return undefined;

  const relative = path.isAbsolute(trimmed) ? path.relative(workspaceRoot, trimmed) : trimmed;
  const normalized = path.posix.normalize(toPosixPath(relative));

  if (normalized === '.' || normalized === './') return '.';
  // `..` anywhere that survives normalisation means the path escapes the root.
  if (normalized === '..' || normalized.startsWith('../')) return undefined;
  return normalized;
}

/** Absolute path of the directory holding notes of the given scope. */
export function notesDirectory(workspaceRoot: string, scope: NoteScope): string {
  return path.join(workspaceRoot, LORE_DIRECTORY, scope === 'team' ? 'notes' : 'local');
}

/** Windows gives us backslashes; the note format is POSIX-only so paths stay portable. */
export function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/** Whether two paths point at the same place. Case-insensitive on Windows, as the filesystem is. */
export function isSamePath(left: string, right: string): boolean {
  return path.relative(left, right) === '';
}

/**
 * The project a note belongs to: the directory holding its `.lore/`.
 *
 * Derived from the note's own path rather than stored in it, so a workspace can
 * contain any number of Lore projects — a monorepo package each, or one per
 * folder of a multi-root workspace — without the format knowing about it.
 */
export function noteRoot(note: Note): string {
  return path.resolve(path.dirname(note.notePath), '..', '..');
}

/** Absolute path of the code a note annotates. */
export function noteTargetPath(note: Note): string {
  return path.resolve(noteRoot(note), note.targetPath);
}

/**
 * The project a path belongs to, deepest match first: a package with its own
 * `.lore/` owns its files, not the monorepo it sits in.
 */
export function rootContaining(roots: string[], filePath: string): string | undefined {
  return roots
    .filter((root) => workspaceRelativePath(root, filePath) !== undefined)
    .sort((left, right) => right.length - left.length)[0];
}

// --------------------------------------------------------------------------
// Parsing and serializing
// --------------------------------------------------------------------------

export function parseNote(rawMarkdown: string, notePath: string, scope: NoteScope): Note {
  const { data, content } = matter(rawMarkdown);
  const body = content.trim();

  return {
    notePath,
    scope,
    // An empty or non-string `path` means the note is about the repository as a
    // whole; treating '' as a file target produces a note anchored to nothing.
    targetPath: toPosixPath(asOptionalString(data.path) ?? '.'),
    title: readTitle(body, notePath),
    body,
    symbol: asOptionalString(data.symbol),
    line: asOptionalLineNumber(data.line),
    snippet: asOptionalString(data.snippet),
    type: NOTE_TYPES.includes(data.type) ? data.type : 'note',
    status: data.status === 'resolved' ? 'resolved' : 'open',
    author: asOptionalString(data.author),
    created: asOptionalDateString(data.created),
    extra: Object.fromEntries(
      Object.entries(data).filter(([key]) => !KNOWN_FRONTMATTER_KEYS.has(key)),
    ),
  };
}

export function serializeNote(note: Note): string {
  // Built in this order so the frontmatter reads top-down: what it points at,
  // then what kind of note it is, then who wrote it.
  const frontmatter: Record<string, unknown> = { path: note.targetPath };
  if (note.symbol) frontmatter.symbol = note.symbol;
  if (note.line !== undefined) frontmatter.line = note.line;
  if (note.snippet) frontmatter.snippet = note.snippet;
  frontmatter.type = note.type;
  frontmatter.status = note.status;
  if (note.author) frontmatter.author = note.author;
  if (note.created) frontmatter.created = note.created;

  return matter.stringify(`${note.body}\n`, { ...frontmatter, ...note.extra });
}

/**
 * The title is the first Markdown heading, falling back to the filename. Keeping
 * it out of the frontmatter means there is no second copy to drift out of sync,
 * and a note opened in any Markdown editor still reads correctly.
 */
function readTitle(body: string, notePath: string): string {
  const heading = body.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  return path.basename(notePath, '.md').replace(/-/g, ' ');
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function asOptionalLineNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** YAML turns an unquoted `2026-07-28` into a Date, so normalise both shapes. */
function asOptionalDateString(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return asOptionalString(value);
}

// --------------------------------------------------------------------------
// Reading and writing the store
// --------------------------------------------------------------------------

export async function readAllNotes(workspaceRoot: string): Promise<Note[]> {
  const [teamNotes, personalNotes] = await Promise.all([
    readNotesFrom(notesDirectory(workspaceRoot, 'team'), 'team'),
    readNotesFrom(notesDirectory(workspaceRoot, 'personal'), 'personal'),
  ]);
  return [...teamNotes, ...personalNotes];
}

async function readNotesFrom(directory: string, scope: NoteScope): Promise<Note[]> {
  const fileNames = await listNoteFileNames(directory);

  const notes = await Promise.all(
    fileNames.map(async (fileName) => {
      const notePath = path.join(directory, fileName);
      try {
        return parseNote(await fs.readFile(notePath, 'utf8'), notePath, scope);
      } catch {
        // One note with broken frontmatter must not blank out the whole sidebar.
        return undefined;
      }
    }),
  );

  return notes.filter((note): note is Note => note !== undefined);
}

/** Note filenames in a directory; an absent directory is normal, not an error. */
export async function listNoteFileNames(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory);
    return entries.filter((entry) => entry.endsWith('.md'));
  } catch {
    return [];
  }
}

/** Re-read one note from disk. Undefined when it is gone or unparseable. */
export async function readNote(notePath: string, scope: NoteScope): Promise<Note | undefined> {
  try {
    return parseNote(await fs.readFile(notePath, 'utf8'), notePath, scope);
  } catch {
    return undefined;
  }
}

export async function writeNote(note: Note): Promise<void> {
  await fs.mkdir(path.dirname(note.notePath), { recursive: true });
  await fs.writeFile(note.notePath, serializeNote(note), 'utf8');
}

/**
 * Move a note to the other scope, which is all sharing amounts to: `.lore/local/`
 * is gitignored and `.lore/notes/` is not, so the directory a note sits in *is*
 * its visibility. Returns the note at its new path.
 *
 * Written before deleting, so a failure midway leaves a duplicate rather than
 * losing the note.
 */
export async function moveNoteToScope(
  workspaceRoot: string,
  note: Note,
  scope: NoteScope,
): Promise<Note> {
  if (note.scope === scope) return note;

  const directory = notesDirectory(workspaceRoot, scope);
  const fileName = toNoteFileName(note.title, await listNoteFileNames(directory));
  const moved: Note = { ...note, scope, notePath: path.join(directory, fileName) };

  await writeNote(moved);
  await fs.rm(note.notePath, { force: true });
  return moved;
}

export function toNoteFileName(title: string, takenFileNames: string[] = []): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_SLUG_LENGTH)
      .replace(/-+$/, '') || 'note';

  let fileName = `${slug}.md`;
  let attempt = 2;
  while (takenFileNames.includes(fileName)) {
    fileName = `${slug}-${attempt}.md`;
    attempt += 1;
  }
  return fileName;
}

/**
 * Personal notes are one careless `git add -A` away from a shared repo, and a
 * later commit cannot un-publish them. So the ignore rule is written the first
 * time a personal note is created rather than left to the user to remember.
 */
export async function ensureLocalIgnored(workspaceRoot: string): Promise<void> {
  const gitignorePath = path.join(workspaceRoot, '.gitignore');

  let existing = '';
  try {
    existing = await fs.readFile(gitignorePath, 'utf8');
  } catch {
    // No .gitignore yet — appending creates one.
  }

  const alreadyIgnored = existing
    .split(/\r?\n/)
    .some((line) => line.trim().replace(/\/+$/, '') === '.lore/local');
  if (alreadyIgnored) return;

  // Blank line to separate us from existing rules, but not at the top of a
  // .gitignore we are creating from scratch.
  const separator = existing === '' ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  await fs.appendFile(
    gitignorePath,
    `${separator}# Lore personal notes — never committed\n${LOCAL_IGNORE_ENTRY}\n`,
    'utf8',
  );
}

// --------------------------------------------------------------------------
// Selecting notes for display
// --------------------------------------------------------------------------

/** A note aimed at a folder (`src/api/`) or the whole repo (`.`) rather than a file. */
export function isDirectoryNote(note: Note): boolean {
  return note.targetPath === '.' || note.targetPath.endsWith('/');
}

/** File notes whose code lives directly in `directoryPath` (workspace-relative). */
export function notesForDirectory(notes: Note[], directoryPath: string): Note[] {
  const directory = toPosixPath(directoryPath).replace(/\/+$/, '');
  return notes.filter((note) => {
    if (isDirectoryNote(note)) return false;
    return parentDirectoryOf(note.targetPath) === directory;
  });
}

/**
 * Notes attached to one specific file, matched on its absolute path.
 *
 * Absolute rather than relative because a workspace holds several projects and
 * two of them routinely both have a `src/index.ts` — matching on the relative
 * path would paint one project's notes onto the other project's file.
 */
export function notesForAbsolutePath(notes: Note[], filePath: string): Note[] {
  return notes.filter(
    (note) => !isDirectoryNote(note) && isSamePath(noteTargetPath(note), filePath),
  );
}

/** Folder- and repo-scoped notes, which belong in their own sidebar group. */
export function workspaceNotes(notes: Note[]): Note[] {
  return notes.filter(isDirectoryNote);
}

/**
 * Every note bearing on a file: its own, plus each ancestor folder's, plus the
 * repository-wide ones. Ordered broadest first, so a reader meets the general
 * rules before the specific exception to them.
 *
 * This is what an agent needs before touching a file — a `.lore/notes/api.md`
 * saying "never change these response shapes" applies to every file under
 * `src/api/`, not only to the one it was written against.
 */
export function notesApplyingTo(notes: Note[], targetPath: string): Note[] {
  // Normalised so './src/a.py' and 'src/a.py' resolve alike. Absolute paths must
  // be put through workspaceRelativePath first — this cannot know the root.
  const target = path.posix.normalize(toPosixPath(targetPath));
  const isDirectory = target === '.' || target.endsWith('/');

  const segments = target.split('/').filter((segment) => segment !== '' && segment !== '.');
  // A folder target is its own last scope; a file target's last scope is itself.
  const folderCount = isDirectory ? segments.length : segments.length - 1;

  const scopes = ['.'];
  for (let depth = 1; depth <= folderCount; depth += 1) {
    scopes.push(`${segments.slice(0, depth).join('/')}/`);
  }
  if (!isDirectory) scopes.push(target);

  return scopes.flatMap((scope) => notes.filter((note) => note.targetPath === scope));
}

/** Case-insensitive substring match over the parts of a note worth searching. */
export function searchNotes(notes: Note[], query: string): Note[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];

  return notes.filter((note) =>
    [note.title, note.body, note.targetPath, note.symbol ?? ''].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  );
}

function parentDirectoryOf(targetPath: string): string {
  const segments = toPosixPath(targetPath).split('/');
  return segments.slice(0, -1).join('/');
}

// --------------------------------------------------------------------------
// Anchoring
// --------------------------------------------------------------------------

/**
 * Locate a note's snippet in the current text, returning a 0-indexed line or -1.
 *
 * The stored line number is only a hint: any edit above the note invalidates it.
 * Searching outward from the hint (rather than top-down) means a duplicated line
 * such as a bare `}` resolves to the nearest match instead of the first one in
 * the file.
 *
 * ponytail: exact trimmed-line match. If reformatting starts orphaning notes,
 * upgrade to a similarity score over a window of lines.
 */
export function findSnippetLine(
  documentText: string,
  snippet: string | undefined,
  hintLine: number | undefined,
): number {
  const target = snippet?.trim();
  if (!target) return -1;

  const lines = documentText.split(/\r?\n/);
  const matchesAt = (index: number): boolean => lines[index]?.trim() === target;

  // Downward is checked first: when a duplicated line matches at equal distance
  // on both sides, the code has more likely drifted down (something was inserted
  // above it) than up. Checking upward first picked the earlier duplicate.
  const hintIndex = (hintLine ?? 1) - 1;
  for (let distance = 0; distance <= SNIPPET_SEARCH_RADIUS; distance += 1) {
    if (matchesAt(hintIndex + distance)) return hintIndex + distance;
    if (matchesAt(hintIndex - distance)) return hintIndex - distance;
  }

  // Moved further than the radius — fall back to scanning the whole file.
  return lines.findIndex((line) => line.trim() === target);
}

/**
 * The 0-indexed line a note's snippet points at, or undefined when the exact
 * code it was written against is no longer in the file.
 *
 * Undefined is not the end of the road — {@link findSymbolLine} is tried next by
 * the caller. But a stale line number is never returned: a marker sitting beside
 * unrelated code is worse than no marker, and the sidebar lists the note either way.
 */
export function resolveNoteLine(note: Note, documentText: string): number | undefined {
  if (note.snippet) {
    const foundLine = findSnippetLine(documentText, note.snippet, note.line);
    return foundLine >= 0 ? foundLine : undefined;
  }
  return note.line === undefined ? undefined : note.line - 1;
}

/**
 * A language-agnostic view of a document's symbols, so the matching below stays
 * testable without an extension host. Built from vscode.DocumentSymbol.
 */
export interface SymbolOutline {
  name: string;
  /** 0-indexed line of the symbol's declaration. */
  line: number;
  children: SymbolOutline[];
}

/**
 * Line of the symbol a note was attached to, e.g. `Calculator.divide`.
 *
 * This is what keeps a note attached when the annotated line itself is edited —
 * adding a parameter or a type hint defeats the snippet, but the function is
 * still the function.
 */
export function findSymbolLine(outline: SymbolOutline[], dottedName: string): number | undefined {
  const pathSegments = dottedName.split('.');

  const exactMatch = findByPath(outline, pathSegments);
  if (exactMatch !== undefined) return exactMatch;

  // The path broke — most often a renamed parent class. The leaf name is still an
  // unambiguous answer when exactly one symbol carries it; two or more and we
  // would be guessing, so the note goes to the Unanchored bucket instead.
  const leafName = pathSegments[pathSegments.length - 1];
  const leafMatches = collectLinesNamed(outline, leafName);
  return leafMatches.length === 1 ? leafMatches[0] : undefined;
}

function findByPath(symbols: SymbolOutline[], pathSegments: string[]): number | undefined {
  const [head, ...rest] = pathSegments;
  const match = symbols.find((symbol) => symbol.name === head);
  if (!match) return undefined;
  return rest.length === 0 ? match.line : findByPath(match.children, rest);
}

function collectLinesNamed(symbols: SymbolOutline[], name: string): number[] {
  return symbols.flatMap((symbol) => [
    ...(symbol.name === name ? [symbol.line] : []),
    ...collectLinesNamed(symbol.children, name),
  ]);
}
