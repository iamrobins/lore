/**
 * The Claude Code hook that puts Lore notes in front of the agent.
 *
 * An MCP tool only helps when the model decides to call it, which it does when
 * curious about a file — not reliably before editing one. "Before editing" is
 * the moment the notes matter, so a PreToolUse hook supplies them whether or not
 * the model thought to look.
 *
 * Deliberately emits only `additionalContext`. Returning `permissionDecision`
 * here would auto-approve every Read, Edit and Write the hook matches, silently
 * disabling permission prompts nobody asked to disable. Notes are context, not
 * authorisation.
 *
 * Usage: node hook.js <session|pre>, hook payload on stdin.
 */

import {
  Note,
  isDirectoryNote,
  notesApplyingTo,
  readAllNotes,
  workspaceNotes,
  workspaceRelativePath,
} from '../../src/noteStore';

interface HookPayload {
  cwd?: string;
  tool_input?: { file_path?: string };
}

type HookEvent = 'session' | 'pre';

const HOOK_EVENT_NAMES: Record<HookEvent, string> = {
  session: 'SessionStart',
  pre: 'PreToolUse',
};

async function main(): Promise<void> {
  const event = process.argv[2] === 'session' ? 'session' : 'pre';
  const payload = await readPayload();

  // Claude Code reports the project directory; falling back to our own cwd keeps
  // the hook usable when run by hand.
  const workspaceRoot = payload.cwd ?? process.cwd();
  const notes = await readAllNotes(workspaceRoot);
  if (notes.length === 0) return;

  const context = event === 'session'
    ? describeRepositoryNotes(notes)
    : describeFileNotes(notes, workspaceRoot, payload.tool_input?.file_path);

  if (context) emitContext(event, context);
}

/**
 * At session start, only repository- and folder-wide notes are worth injecting.
 * Every file note would flood the context with things the agent may never touch.
 */
function describeRepositoryNotes(notes: Note[]): string | undefined {
  const broadNotes = workspaceNotes(notes);
  if (broadNotes.length === 0) return undefined;

  return [
    'Lore notes apply to this repository. They record why code is the way it is,',
    'constraints not visible in the source, and how files may be changed.',
    'Use the lore_read tool for a specific file, or lore_search to look something up.',
    '',
    ...broadNotes.map(renderNote),
  ].join('\n');
}

function describeFileNotes(
  notes: Note[],
  workspaceRoot: string,
  filePath: string | undefined,
): string | undefined {
  if (!filePath) return undefined;

  // Handles the absolute paths Claude Code passes, on either path separator, and
  // returns undefined for anything outside the workspace.
  const relativePath = workspaceRelativePath(workspaceRoot, filePath);
  if (relativePath === undefined) return undefined;

  const applicable = notesApplyingTo(notes, relativePath);
  if (applicable.length === 0) return undefined;

  return [
    `Lore notes for ${relativePath}. These were written by developers about`,
    'this code. Respect them; if one must be broken, say so rather than doing it silently.',
    '',
    ...applicable.map(renderNote),
  ].join('\n');
}

function renderNote(note: Note): string {
  const target = isDirectoryNote(note)
    ? note.targetPath === '.'
      ? 'whole repository'
      : note.targetPath
    : [note.targetPath, note.symbol, note.line === undefined ? undefined : `line ${note.line}`]
        .filter(Boolean)
        .join(' · ');

  return [`--- ${target} [${note.type}]`, note.body, ''].join('\n');
}

function emitContext(event: HookEvent, additionalContext: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: HOOK_EVENT_NAMES[event], additionalContext },
    }),
  );
}

async function readPayload(): Promise<HookPayload> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as HookPayload;
  } catch {
    return {};
  }
}

// A hook that throws would surface an error on every tool call. Notes are a
// convenience; failing to load them must never obstruct the agent's work.
main().catch(() => process.exit(0));
