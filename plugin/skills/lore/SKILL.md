---
name: lore
description: Read and write Lore notes — durable developer notes stored in a repository's .lore/ directory rather than as source comments. Use when the user asks to record why something is the way it is, to leave a note or reminder on code, to set a rule for how a file may be edited, or to recall past decisions and constraints. Also use when about to change code that a note may govern.
---

# Lore notes

Lore keeps developer knowledge beside the code instead of inside it: `.lore/*.md`
files that record why code is the way it is, constraints invisible in the source,
and instructions about how it may be changed. Nothing is added to the source file.

Notes for a file are supplied automatically before you read or edit it. The tools
below are for everything else.

## Reading

- `lore_read(path)` — notes bearing on a file, including its parent folders' and
  the repository's, broadest first
- `lore_search(query)` — keyword search across titles, bodies, paths and symbols

Reach for `lore_search` when the user asks why something was done, or when code
looks wrong in a way that suggests a reason you cannot see. A note explaining a
deliberate workaround is exactly the thing that stops you "fixing" it.

## Writing

`lore_write(path, title, body, …)` records a note. Good candidates:

- why a non-obvious decision was made, and what it depends on
- a constraint that will not be visible to the next reader
- a workaround and the upstream bug that forces it
- something the user says they want remembered

`path` is a file, a folder (`src/api/`), or `.` for the repository. A folder note
applies to everything beneath it.

Anchor to a symbol when you can: pass `symbol` (`AuthService.login`), `line`, and
`snippet` — the line's exact text. That is what lets a note follow the code as it
moves and gets edited.

### Type

`type: "ai-instruction"` marks a note as a rule for agents editing the code
rather than an observation. Use it when the user is telling you how this code
must be treated in future, not merely describing it.

### Scope

Defaults to `personal`, written to the gitignored `.lore/local/`.

Only pass `scope: "team"` when the user asks for something the whole team should
see — it writes to `.lore/notes/`, which is committed to the repository and will
reach everyone who pulls.

## Respecting notes

Treat notes as written by a colleague who knew something you do not. If a note
forbids a change the user has asked for, do not silently comply and do not
silently refuse — say which note is in the way and let the user decide.
