---
description: Record a Lore note about the code you are working on
---

Record a Lore note capturing this: $ARGUMENTS

Write it with `lore_write`, and before doing so:

- Work out what the note is really about — a specific file, a folder, or the
  whole repository — and set `path` accordingly.
- Anchor it when it concerns particular code: pass `symbol`, `line`, and
  `snippet` (that line's exact text) so the note follows the code as it moves.
- Write the body for whoever reads it in six months with none of today's
  context. Say why, not what; the code already says what.
- Use `type: "ai-instruction"` if this is a rule about how the code must be
  edited, rather than an observation about it.
- Leave the scope personal unless the request was clearly about something the
  whole team needs, since team notes are committed to the repository.

If the request is too vague to anchor or to write usefully, ask what it is about
before writing anything.
