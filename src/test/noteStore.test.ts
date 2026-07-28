import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  ensureLocalIgnored,
  findSnippetLine,
  findSymbolLine,
  moveNoteToScope,
  notesForDirectory,
  notesForFile,
  parseNote,
  readAllNotes,
  resolveNoteLine,
  serializeNote,
  toNoteFileName,
  workspaceNotes,
  type Note,
} from '../noteStore';

const REALISTIC_NOTE = [
  '---',
  'path: src/payment/service.py',
  'symbol: PaymentService.charge_customer',
  'line: 128',
  'snippet: "async def charge_customer(amount: int, retries: int = 3):"',
  'type: ai-instruction',
  'status: open',
  'created: 2026-07-28',
  '---',
  '',
  '# Payment retry loop',
  '',
  'Never remove the retry loop — it works around a Stripe timeout bug.',
].join('\n');

test('parseNote reads frontmatter, and the title comes from the first heading', () => {
  const note = parseNote(REALISTIC_NOTE, '/repo/.lore/notes/payment-retry-loop.md', 'team');

  assert.equal(note.targetPath, 'src/payment/service.py');
  assert.equal(note.symbol, 'PaymentService.charge_customer');
  assert.equal(note.line, 128);
  assert.equal(note.type, 'ai-instruction');
  assert.equal(note.status, 'open');
  assert.equal(note.scope, 'team');
  assert.equal(note.title, 'Payment retry loop');
  // YAML would otherwise hand back a Date object here.
  assert.equal(note.created, '2026-07-28');
});

test('a snippet full of colons, quotes and parens survives a write/read round trip', () => {
  const note = parseNote(REALISTIC_NOTE, '/repo/.lore/notes/payment-retry-loop.md', 'team');
  const reparsed = parseNote(serializeNote(note), note.notePath, 'team');

  assert.equal(reparsed.snippet, 'async def charge_customer(amount: int, retries: int = 3):');
  assert.deepEqual(reparsed, note);
});

test('parseNote falls back to the filename when a note has no heading', () => {
  const note = parseNote('---\npath: src/a.ts\n---\n\njust a body\n', '/repo/.lore/local/quick-thought.md', 'personal');
  assert.equal(note.title, 'quick thought');
});

test('parseNote tolerates junk instead of guessing', () => {
  const note = parseNote('---\npath: src/a.ts\ntype: nonsense\nline: -4\n---\n\nbody\n', '/x/n.md', 'personal');
  assert.equal(note.type, 'note');
  assert.equal(note.line, undefined);
});

test('findSnippetLine follows code that moved down the file', () => {
  const snippet = 'return charge(amount)';
  const text = [...Array(40).fill('// padding'), snippet, '// after'].join('\n');

  // The note still claims line 5; the code is really on line 41 (index 40).
  assert.equal(findSnippetLine(text, snippet, 5), 40);
});

test('findSnippetLine prefers the match nearest the hint when lines repeat', () => {
  const text = ['}', '// a', '// b', '// c', '}', '// d'].join('\n');
  assert.equal(findSnippetLine(text, '}', 5), 4);
});

test('findSnippetLine reports -1 when the code is gone', () => {
  assert.equal(findSnippetLine('nothing to see here', 'return charge(amount)', 3), -1);
});

test('findSnippetLine reports -1 when a note has no snippet to search for', () => {
  assert.equal(findSnippetLine('some code', undefined, 3), -1);
});

test('toNoteFileName slugs punctuation and de-dupes collisions', () => {
  assert.equal(toNoteFileName("Don't refactor: Stripe v3!"), 'don-t-refactor-stripe-v3.md');
  assert.equal(toNoteFileName('Payment retry', ['payment-retry.md']), 'payment-retry-2.md');
  assert.equal(
    toNoteFileName('Payment retry', ['payment-retry.md', 'payment-retry-2.md']),
    'payment-retry-3.md',
  );
  assert.equal(toNoteFileName('🙂🙂🙂'), 'note.md');
});

test('notesForDirectory matches only the files directly in that directory', () => {
  const notes = [
    noteFor('src/payment/service.py'),
    noteFor('src/payment/cache.py'),
    noteFor('src/auth/login.py'),
    noteFor('src/payment/'),
    noteFor('.'),
  ];

  assert.deepEqual(
    notesForDirectory(notes, 'src/payment').map((note) => note.targetPath),
    ['src/payment/service.py', 'src/payment/cache.py'],
  );
  assert.deepEqual(
    workspaceNotes(notes).map((note) => note.targetPath),
    ['src/payment/', '.'],
  );
});

test('notesForFile matches one file and never folder notes', () => {
  const notes = [noteFor('src/payment/service.py'), noteFor('src/payment/'), noteFor('src/auth/login.py')];

  assert.deepEqual(
    notesForFile(notes, 'src/payment/service.py').map((note) => note.targetPath),
    ['src/payment/service.py'],
  );
  assert.deepEqual(notesForFile(notes, 'src/payment'), []);
});

test('resolveNoteLine converts a 1-indexed note line to a 0-indexed editor line', () => {
  const note = { ...noteFor('src/a.py'), line: 3 };
  assert.equal(resolveNoteLine(note, 'a\nb\nc\nd'), 2);
});

test('resolveNoteLine follows the snippet rather than the stored line', () => {
  const note = { ...noteFor('src/a.py'), line: 1, snippet: 'return a / b' };
  assert.equal(resolveNoteLine(note, 'x\ny\nreturn a / b\nz'), 2);
});

test('resolveNoteLine gives up when the snippet is gone, so no pin is drawn', () => {
  const note = { ...noteFor('src/a.py'), line: 2, snippet: 'return a / b' };
  assert.equal(resolveNoteLine(note, 'x\ny\nz'), undefined);
});

test('resolveNoteLine gives up on a note with neither snippet nor line', () => {
  assert.equal(resolveNoteLine(noteFor('src/a.py'), 'x\ny'), undefined);
});

const CALCULATOR_OUTLINE = [
  {
    name: 'Calculator',
    line: 0,
    children: [
      { name: 'add', line: 1, children: [] },
      { name: 'divide', line: 10, children: [] },
    ],
  },
  { name: 'main', line: 20, children: [] },
];

test('findSymbolLine walks a dotted path to the declaration line', () => {
  assert.equal(findSymbolLine(CALCULATOR_OUTLINE, 'Calculator.divide'), 10);
  assert.equal(findSymbolLine(CALCULATOR_OUTLINE, 'Calculator'), 0);
  assert.equal(findSymbolLine(CALCULATOR_OUTLINE, 'main'), 20);
});

test('findSymbolLine survives a renamed parent when the leaf name is unique', () => {
  // The note was written against Calculator.divide; the class is now SafeCalculator.
  const renamed = [{ ...CALCULATOR_OUTLINE[0], name: 'SafeCalculator' }];
  assert.equal(findSymbolLine(renamed, 'Calculator.divide'), 10);
});

test('findSymbolLine refuses to guess when the leaf name is ambiguous', () => {
  const twoDivides = [
    { name: 'IntCalculator', line: 0, children: [{ name: 'divide', line: 3, children: [] }] },
    { name: 'FloatCalculator', line: 8, children: [{ name: 'divide', line: 11, children: [] }] },
  ];
  assert.equal(findSymbolLine(twoDivides, 'Calculator.divide'), undefined);
});

test('findSymbolLine returns undefined when the symbol is gone entirely', () => {
  assert.equal(findSymbolLine(CALCULATOR_OUTLINE, 'Calculator.modulo'), undefined);
  assert.equal(findSymbolLine([], 'Calculator.divide'), undefined);
});

test('readAllNotes takes scope from the directory and ignores broken notes', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lore-test-'));

  await fs.mkdir(path.join(workspaceRoot, '.lore', 'notes'), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, '.lore', 'local'), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, '.lore', 'notes', 'shared.md'), REALISTIC_NOTE);
  await fs.writeFile(
    path.join(workspaceRoot, '.lore', 'local', 'mine.md'),
    '---\npath: src/a.ts\n---\n\n# Mine\n',
  );
  await fs.writeFile(path.join(workspaceRoot, '.lore', 'local', 'broken.md'), '---\n: : :\nnope\n---\n');
  await fs.writeFile(path.join(workspaceRoot, '.lore', 'local', 'ignored.txt'), 'not a note');

  const notes = await readAllNotes(workspaceRoot);

  assert.deepEqual(
    notes.map((note) => [note.title, note.scope]).sort(),
    [['Mine', 'personal'], ['Payment retry loop', 'team']],
  );

  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

test('readAllNotes returns nothing rather than throwing when .lore is absent', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lore-test-'));
  assert.deepEqual(await readAllNotes(workspaceRoot), []);
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

test('moveNoteToScope moves the file between directories and keeps the body', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lore-test-'));
  const personalPath = path.join(workspaceRoot, '.lore', 'local', 'payment-retry-loop.md');
  const note = parseNote(REALISTIC_NOTE, personalPath, 'personal');
  await fs.mkdir(path.dirname(personalPath), { recursive: true });
  await fs.writeFile(personalPath, serializeNote(note));

  const shared = await moveNoteToScope(workspaceRoot, note, 'team');

  assert.equal(shared.scope, 'team');
  assert.equal(path.dirname(shared.notePath), path.join(workspaceRoot, '.lore', 'notes'));
  // The old copy is gone, so the note is not listed twice.
  assert.equal(await pathExists(personalPath), false);

  const [reread] = await readAllNotes(workspaceRoot);
  assert.equal(reread.scope, 'team');
  assert.equal(reread.title, 'Payment retry loop');
  assert.equal(reread.snippet, note.snippet);

  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

test('moveNoteToScope avoids clobbering a team note of the same name', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lore-test-'));
  const teamDirectory = path.join(workspaceRoot, '.lore', 'notes');
  await fs.mkdir(teamDirectory, { recursive: true });
  await fs.writeFile(path.join(teamDirectory, 'payment-retry-loop.md'), REALISTIC_NOTE);

  const personalPath = path.join(workspaceRoot, '.lore', 'local', 'payment-retry-loop.md');
  const note = parseNote(REALISTIC_NOTE, personalPath, 'personal');
  await fs.mkdir(path.dirname(personalPath), { recursive: true });
  await fs.writeFile(personalPath, serializeNote(note));

  const shared = await moveNoteToScope(workspaceRoot, note, 'team');

  assert.equal(path.basename(shared.notePath), 'payment-retry-loop-2.md');
  assert.equal((await readAllNotes(workspaceRoot)).length, 2);

  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

test('moveNoteToScope is a no-op when the note is already in that scope', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lore-test-'));
  const notePath = path.join(workspaceRoot, '.lore', 'notes', 'shared.md');
  const note = parseNote(REALISTIC_NOTE, notePath, 'team');
  await fs.mkdir(path.dirname(notePath), { recursive: true });
  await fs.writeFile(notePath, serializeNote(note));

  const result = await moveNoteToScope(workspaceRoot, note, 'team');

  assert.equal(result.notePath, notePath);
  assert.equal(await pathExists(notePath), true);

  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

test('ensureLocalIgnored adds the rule once and never duplicates it', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lore-test-'));
  const gitignorePath = path.join(workspaceRoot, '.gitignore');
  await fs.writeFile(gitignorePath, 'node_modules/');

  await ensureLocalIgnored(workspaceRoot);
  await ensureLocalIgnored(workspaceRoot);

  const contents = await fs.readFile(gitignorePath, 'utf8');
  const occurrences = contents.split('\n').filter((line) => line.trim() === '.lore/local/').length;
  assert.equal(occurrences, 1);
  assert.match(contents, /^node_modules\/$/m);

  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

test('ensureLocalIgnored creates a .gitignore that does not start with a blank line', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lore-test-'));

  await ensureLocalIgnored(workspaceRoot);

  const contents = await fs.readFile(path.join(workspaceRoot, '.gitignore'), 'utf8');
  assert.equal(contents, '# Lore personal notes — never committed\n.lore/local/\n');

  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

test('ensureLocalIgnored leaves one blank line between existing rules and ours', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lore-test-'));
  await fs.writeFile(path.join(workspaceRoot, '.gitignore'), '__pycache__/\n');

  await ensureLocalIgnored(workspaceRoot);

  const contents = await fs.readFile(path.join(workspaceRoot, '.gitignore'), 'utf8');
  assert.equal(contents, '__pycache__/\n\n# Lore personal notes — never committed\n.lore/local/\n');

  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

test('ensureLocalIgnored recognises the rule written without a trailing slash', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lore-test-'));
  await fs.writeFile(path.join(workspaceRoot, '.gitignore'), '.lore/local\n');

  await ensureLocalIgnored(workspaceRoot);

  const contents = await fs.readFile(path.join(workspaceRoot, '.gitignore'), 'utf8');
  assert.equal(contents, '.lore/local\n');

  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function noteFor(targetPath: string): Note {
  return {
    notePath: `/repo/.lore/local/${targetPath.replace(/[^a-z0-9]/gi, '-')}.md`,
    targetPath,
    scope: 'personal',
    title: targetPath,
    body: '',
    type: 'note',
    status: 'open',
  };
}
