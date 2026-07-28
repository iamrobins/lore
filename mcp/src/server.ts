/**
 * Lore over MCP: the same `.lore/` notes the VS Code extension reads, exposed to
 * any agent that speaks the Model Context Protocol — Claude Code, Codex, Cursor,
 * Cline, Zed.
 *
 * The store is imported straight from the extension's source. That module was
 * written without a `vscode` import precisely so this file could reuse it
 * unchanged, which keeps one implementation of the format rather than two that
 * drift.
 */

import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  Note,
  NoteScope,
  ensureLocalIgnored,
  listNoteFileNames,
  notesApplyingTo,
  notesDirectory,
  readAllNotes,
  searchNotes,
  toNoteFileName,
  toPosixPath,
  workspaceRelativePath,
  writeNote,
} from '../../src/noteStore';

/**
 * Agents are launched with the project as their working directory. An explicit
 * argument wins, so the server can be pointed elsewhere in a config file.
 */
const workspaceRoot = path.resolve(process.argv[2] ?? process.env.LORE_ROOT ?? process.cwd());

const server = new McpServer({ name: 'lore', version: '0.1.0' });

server.registerTool(
  'lore_read',
  {
    title: 'Read Lore notes for a file',
    description:
      'Developer notes attached to a file, plus notes on its parent folders and the repository as a whole. ' +
      'Call this before editing a file: notes record why code is the way it is, constraints that are not ' +
      'visible in the source, and instructions about how the file may be changed.',
    inputSchema: {
      path: z
        .string()
        .describe('Repository-relative path of the file, e.g. "src/payment/service.py".'),
    },
  },
  async ({ path: targetPath }) => {
    // Agents hold absolute paths — that is what Claude Code's Read and Edit
    // tools require — so normalising here is what makes this tool work at all
    // for its main caller.
    const relativePath = workspaceRelativePath(workspaceRoot, targetPath);
    if (relativePath === undefined) {
      return textResult(`${targetPath} is outside this repository, so it has no Lore notes.`);
    }

    const applicable = notesApplyingTo(await readAllNotes(workspaceRoot), relativePath);

    if (applicable.length === 0) {
      return textResult(`No Lore notes apply to ${relativePath}.`);
    }
    return textResult(
      [`${applicable.length} Lore note(s) apply to ${relativePath}:`, '', ...applicable.map(renderNote)].join('\n'),
    );
  },
);

server.registerTool(
  'lore_search',
  {
    title: 'Search Lore notes',
    description:
      'Find developer notes across the repository by keyword. Searches note titles, bodies, file paths and ' +
      'symbol names. Use it to recover context that is not in the code: past decisions, migration plans, ' +
      'known bugs being worked around.',
    inputSchema: {
      query: z.string().describe('Text to look for, e.g. "stripe" or "migration".'),
    },
  },
  async ({ query }) => {
    const matches = searchNotes(await readAllNotes(workspaceRoot), query);

    if (matches.length === 0) return textResult(`No Lore notes match "${query}".`);
    return textResult(
      [`${matches.length} Lore note(s) match "${query}":`, '', ...matches.map(renderNote)].join('\n'),
    );
  },
);

server.registerTool(
  'lore_write',
  {
    title: 'Write a Lore note',
    description:
      'Record a durable note about code, stored beside the repository rather than as a source comment. ' +
      'Use it for knowledge worth keeping but wrong to put in the file itself: why a workaround exists, a ' +
      'constraint to respect, a decision and its reasoning.',
    inputSchema: {
      path: z
        .string()
        .describe(
          'What the note is about: a file ("src/api/auth.py"), a folder ("src/api/"), or "." for the repository.',
        ),
      title: z.string().describe('Short title, also used for the note filename.'),
      body: z.string().describe('The note itself, as Markdown.'),
      symbol: z
        .string()
        .optional()
        .describe('Enclosing symbol, e.g. "AuthService.login", so the note survives the code moving.'),
      line: z.number().int().positive().optional().describe('1-indexed line the note is about.'),
      snippet: z
        .string()
        .optional()
        .describe('Text of that line, used to re-find it after the file changes.'),
      type: z
        .enum(['note', 'ai-instruction', 'warning', 'todo', 'doc'])
        .optional()
        .describe('Defaults to "note". Use "ai-instruction" for guidance aimed at AI agents editing this code.'),
      scope: z
        .enum(['personal', 'team'])
        .optional()
        .describe(
          'Defaults to "personal", which is gitignored. Use "team" only when the user has asked for a note ' +
            'shared with the repository, since that will be committed.',
        ),
    },
  },
  async ({ path: targetPath, title, body, symbol, line, snippet, type, scope }) => {
    // An absolute path stored verbatim would produce a note that is written
    // successfully, reported successfully, and never matches a file again.
    const relativePath = workspaceRelativePath(workspaceRoot, targetPath);
    if (relativePath === undefined) {
      return textResult(
        `Cannot write a note for ${targetPath}: it is outside this repository.`,
      );
    }

    const noteScope: NoteScope = scope ?? 'personal';
    const directory = notesDirectory(workspaceRoot, noteScope);
    const fileName = toNoteFileName(title, await listNoteFileNames(directory));

    const note: Note = {
      notePath: path.join(directory, fileName),
      targetPath: relativePath,
      scope: noteScope,
      title,
      // The title leads as an H1 so the file reads correctly in any Markdown
      // editor and the extension can recover the title from the body.
      body: body.trimStart().startsWith('# ') ? body : `# ${title}\n\n${body}`,
      symbol,
      line,
      snippet,
      type: type ?? 'note',
      status: 'open',
      created: new Date().toISOString().slice(0, 10),
    };

    // Same leak guard the extension applies: a personal note must not be one
    // careless `git add -A` away from the shared repository.
    if (noteScope === 'personal') await ensureLocalIgnored(workspaceRoot);
    await writeNote(note);

    return textResult(
      `Wrote ${noteScope} note "${title}" to ${toPosixPath(path.relative(workspaceRoot, note.notePath))}.`,
    );
  },
);

function renderNote(note: Note): string {
  const location = [note.symbol, note.line === undefined ? undefined : `line ${note.line}`]
    .filter(Boolean)
    .join(', ');

  return [
    `--- ${note.targetPath}${location ? ` (${location})` : ''}`,
    `scope: ${note.scope} | type: ${note.type}${note.status === 'resolved' ? ' | resolved' : ''}`,
    '',
    note.body,
    '',
  ].join('\n');
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

await server.connect(new StdioServerTransport());
