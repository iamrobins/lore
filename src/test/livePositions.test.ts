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
  lines.set('/notes/orphan.md', undefined);

  positions.applyEdits('file:///calc.py', [insertAt(0, 0, 2)]);

  assert.equal(lines.get('/notes/a.md'), 7);
  assert.equal(lines.get('/notes/b.md'), 21);
  // An unanchored note has no line to shift and must stay unanchored.
  assert.equal(lines.get('/notes/orphan.md'), undefined);
  assert.equal(lines.has('/notes/orphan.md'), true);
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
