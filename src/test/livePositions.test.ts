import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LivePositions, shiftLine, shiftLineThrough, type LineEdit } from '../livePositions';

/** A single-line edit that replaces part of one line, adding no newlines. */
function editWithinLine(line: number, startCharacter = 4): LineEdit {
  return { startLine: line, startCharacter, endLine: line, addedLineCount: 0 };
}

/** Typing that inserts `addedLineCount` newlines at the given position. */
function insertAt(line: number, startCharacter: number, addedLineCount: number): LineEdit {
  return { startLine: line, startCharacter, endLine: line, addedLineCount };
}

/** Deleting whole lines, from startLine up to and including endLine. */
function deleteLines(startLine: number, endLine: number): LineEdit {
  return { startLine, startCharacter: 0, endLine, addedLineCount: 0 };
}

test('a note stays put when its own line is edited', () => {
  // This is the whole reason the module exists: rewriting the annotated line
  // must not detach the note from it.
  assert.equal(shiftLine(19, editWithinLine(19)), 19);
});

test('a note moves down when lines are inserted above it', () => {
  assert.equal(shiftLine(19, insertAt(5, 0, 3)), 22);
});

test('a note moves up when lines above it are deleted', () => {
  assert.equal(shiftLine(19, deleteLines(5, 8)), 16);
});

test('a note is untouched by edits below it', () => {
  assert.equal(shiftLine(19, editWithinLine(30)), 19);
  assert.equal(shiftLine(19, insertAt(30, 0, 5)), 19);
});

test('pressing Enter at the start of the annotated line carries the note down', () => {
  assert.equal(shiftLine(19, insertAt(19, 0, 1)), 20);
});

test('pressing Enter at the end of the annotated line leaves the note behind', () => {
  // The annotated content stays on line 19; only what follows moves.
  assert.equal(shiftLine(19, insertAt(19, 42, 1)), 19);
});

test('a replacement that consumes the annotated line leaves the note on it', () => {
  // Regression: the "pushed down from column zero" branch used to fire for any
  // edit starting on the tracked line, including ones that replaced it, and then
  // added the replacement's height on top — walking the note off the new text.

  // Select the line and paste a replacement (Ctrl+L, paste).
  assert.equal(shiftLine(3, { startLine: 3, startCharacter: 0, endLine: 4, addedLineCount: 1 }), 3);

  // Replace three lines starting at the note's line with three new ones.
  assert.equal(shiftLine(3, { startLine: 3, startCharacter: 0, endLine: 5, addedLineCount: 3 }), 3);

  // Format-on-save: one edit replacing the whole document. A note on line 1 of
  // any file was destroyed by this.
  assert.equal(shiftLine(0, { startLine: 0, startCharacter: 0, endLine: 2, addedLineCount: 3 }), 0);
});

test('a note swallowed by a multi-line replacement clamps into the new text', () => {
  // Lines 10 to 20 replaced by two lines; a note on 15 has nowhere exact to go.
  assert.equal(shiftLine(15, { startLine: 10, startCharacter: 0, endLine: 20, addedLineCount: 1 }), 11);
});

test('a note never lands above the edit that consumed it', () => {
  assert.equal(shiftLine(15, deleteLines(10, 20)), 10);
});

test('edits apply in sequence, each against the state the previous one left', () => {
  const edits = [insertAt(0, 0, 2), deleteLines(0, 1), editWithinLine(19)];
  assert.equal(shiftLineThrough(19, edits), 20);
});

test('LivePositions shifts every tracked note in a document at once', () => {
  const positions = new LivePositions();
  const lines = positions.linesFor('file:///calc.py');
  lines.set('/notes/a.md', 5);
  lines.set('/notes/b.md', 19);

  positions.applyEdits('file:///calc.py', [insertAt(0, 0, 2)]);

  assert.equal(lines.get('/notes/a.md'), 7);
  assert.equal(lines.get('/notes/b.md'), 21);
});

test('forgetNote drops one note across every document', () => {
  // A surviving entry would pin a re-anchored note to its old line, and a new
  // note slugging to a deleted note's filename would inherit its position.
  const positions = new LivePositions();
  positions.linesFor('file:///a.py').set('/notes/shared.md', 5);
  positions.linesFor('file:///b.py').set('/notes/shared.md', 9);
  positions.linesFor('file:///b.py').set('/notes/other.md', 3);

  positions.forgetNote('/notes/shared.md');

  assert.equal(positions.linesFor('file:///a.py').has('/notes/shared.md'), false);
  assert.equal(positions.linesFor('file:///b.py').has('/notes/shared.md'), false);
  assert.equal(positions.linesFor('file:///b.py').get('/notes/other.md'), 3);
});

test('peek does not create an entry for an untracked document', () => {
  const positions = new LivePositions();
  assert.equal(positions.peek('file:///never-opened.py'), undefined);
});

test('LivePositions leaves other documents alone', () => {
  const positions = new LivePositions();
  positions.linesFor('file:///a.py').set('/notes/a.md', 5);
  positions.linesFor('file:///b.py').set('/notes/b.md', 5);

  positions.applyEdits('file:///a.py', [insertAt(0, 0, 10)]);

  assert.equal(positions.linesFor('file:///a.py').get('/notes/a.md'), 15);
  assert.equal(positions.linesFor('file:///b.py').get('/notes/b.md'), 5);
});

test('forgetting a document makes its notes resolve afresh', () => {
  const positions = new LivePositions();
  positions.linesFor('file:///a.py').set('/notes/a.md', 5);

  positions.forgetDocument('file:///a.py');

  assert.equal(positions.linesFor('file:///a.py').size, 0);
});

test('forgetAll clears every document, as re-attaching requires', () => {
  const positions = new LivePositions();
  positions.linesFor('file:///a.py').set('/notes/a.md', 5);
  positions.linesFor('file:///b.py').set('/notes/b.md', 5);

  positions.forgetAll();

  assert.equal(positions.linesFor('file:///a.py').size, 0);
  assert.equal(positions.linesFor('file:///b.py').size, 0);
});
