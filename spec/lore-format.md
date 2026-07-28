# The Lore note format

**Version 1.0 — 2026-07-28**

A file format for developer notes that live beside source code rather than
inside it, readable by editors, AI coding agents, CI, and documentation tools.

This document is the authority on the format. The
[VS Code extension](https://github.com/iamrobins/lore) is one implementation of
it, not its definition. Anything not stated here is not part of the format, and
implementations may differ.

The key words MUST, SHOULD, and MAY are used as in RFC 2119.

---

## 1. Why a format

Some knowledge about code cannot live in the code: why a workaround exists,
which constraint is invisible in the file, what must not be changed and until
when. Written as comments it pollutes diffs, drifts, and gets deleted by the
next tool that rewrites the file. Written nowhere, it leaves with whoever knew it.

The format's only real design goal is that **the notes outlive any one tool that
reads them**. Everything below follows from that: plain Markdown, one file per
note, no index, no database, no required runtime.

---

## 2. Layout

Notes live in a `.lore/` directory at the root of a repository.

```
.lore/
  notes/          team scope — committed to version control
  local/          personal scope — excluded from version control
```

- A note file MUST have a `.md` extension. Files with other extensions MUST be
  ignored.
- Implementations MUST read both directories, and MUST NOT require either to exist.
- Implementations MAY ignore subdirectories of `notes/` and `local/`. Version 1.0
  does not define their meaning.
- A tool that creates a note in `local/` SHOULD ensure `.lore/local/` is ignored
  by version control.

### Scope

A note's **scope** is determined solely by which directory contains it:

| Directory | Scope | Meaning |
|---|---|---|
| `.lore/notes/` | `team` | Shared. Travels with the repository. |
| `.lore/local/` | `personal` | Private to one working copy. |

Scope MUST NOT be recorded inside the note. Moving the file is what changes it.
This is deliberate: a permission expressed as a field can disagree with where the
file actually is, and version control is what enforces the distinction anyway.

### Identity

A note's identity is its path. There is no id field.

Implementations MUST NOT assume filenames are stable, and MUST NOT store
cross-references to notes by filename. Two notes MAY have the same title.

---

## 3. File structure

A note is a UTF-8 Markdown file with a YAML frontmatter block.

```markdown
---
path: src/payment/service.py
symbol: PaymentService.charge_customer
line: 128
snippet: "async def charge_customer(amount: int, retries: int = 3):"
type: ai-instruction
status: open
author: robin
created: 2026-07-28
---

# Payment retry loop

Never remove the retry loop — it works around a Stripe timeout bug.
Remove only after ticket #841.
```

- The frontmatter block MUST be delimited by `---` on its own line, opening on
  the first line of the file.
- The body is Markdown with no restrictions. Implementations SHOULD render it,
  and MUST NOT require any particular structure.
- A file with no frontmatter block is a valid note in which every field takes its
  default.

### Title

The title is **not** a frontmatter field. It is derived, in order:

1. The first level-1 ATX heading in the body (`# Title`)
2. Otherwise, the filename without `.md`, with `-` replaced by spaces

Keeping the title out of the frontmatter means there is no second copy to drift
out of sync with the heading a human sees when they open the file.

---

## 4. Fields

Every field is optional. An absent, empty, or wrongly-typed field MUST fall back
to its default rather than making the note invalid.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `path` | string | `.` | What the note is about — see §5 |
| `symbol` | string | absent | Enclosing symbol, e.g. `PaymentService.charge_customer` |
| `line` | integer ≥ 1 | absent | **1-indexed** line the note is about |
| `snippet` | string | absent | Exact text of that line, used to re-find it |
| `type` | enum | `note` | See below |
| `status` | `open` \| `resolved` | `open` | `resolved` notes SHOULD be hidden by default |
| `author` | string | absent | Free text; no defined format |
| `created` | date | absent | ISO 8601 date, `YYYY-MM-DD` |

### `type`

| Value | Meaning |
|---|---|
| `note` | An observation. The default. |
| `ai-instruction` | A rule for AI agents editing this code, not a description of it. |
| `warning` | Something likely to cause harm if ignored. |
| `todo` | Work not yet done. |
| `doc` | Reference documentation. |

An unrecognised `type` MUST be treated as `note`. Implementations MAY define
additional values, but MUST NOT rely on other tools understanding them.

`ai-instruction` is the one type with defined behaviour: an AI agent that reads a
note of this type SHOULD treat it as binding on edits it makes, and SHOULD report
rather than silently ignore an instruction it cannot follow.

### Unknown fields

Implementations MUST preserve frontmatter keys they do not recognise when
rewriting a note. Notes are hand-edited and are extended by other tools; silently
dropping a `ticket:` because this version does not know the key is data loss.

### Type coercion

YAML is permissive, so implementations MUST tolerate the results:

- An unquoted date such as `2026-07-28` parses as a date value, not a string.
  Implementations MUST accept both and normalise to `YYYY-MM-DD`.
- A `line` that is zero, negative, fractional, or non-numeric MUST be treated as absent.
- A `snippet`, `symbol`, or `author` that is not a string MUST be treated as absent.
- An empty-string `path` MUST be treated as `.`.

---

## 5. `path`: what a note is about

`path` is a **repository-relative POSIX path**. It MUST use `/` separators on
every platform, and MUST NOT be absolute or contain `..`.

It takes one of three shapes:

| Shape | Example | Applies to |
|---|---|---|
| File | `src/api/auth.py` | that file |
| Folder — **trailing slash required** | `src/api/` | everything beneath it, recursively |
| Repository | `.` | the whole repository |

The trailing slash is the only thing distinguishing a folder from a file, and it
is significant.

### Inheritance

The notes applying to a file are its own, plus every ancestor folder's, plus the
repository's. For `src/api/auth.py`:

```
.
src/
src/api/
src/api/auth.py
```

Implementations that present notes to a reader SHOULD order them **broadest
first**, so a general rule is met before the specific exception to it, and MUST
NOT list the same note twice.

Consumers taking a path from an untrusted source — an AI agent, a CLI argument —
MUST normalise it to this form before matching, and MUST reject paths that
resolve outside the repository.

---

## 6. Anchoring

`line` alone is not an anchor. It is a hint that goes stale the moment anything
is inserted above it. Anchoring is the one part of this format with real
behaviour attached, because a note pointing at the wrong code is worse than no
note.

Implementations that locate a note within a file SHOULD resolve in this order:

1. **`snippet` near `line`.** Search outward from `line` for a line whose
   trimmed text equals the trimmed `snippet`. Most precise: it keeps a note on
   its own line rather than sliding it to the top of a function.
2. **`snippet` anywhere in the file.** The code moved further than the search
   window.
3. **`symbol`.** The declaration line of the named symbol. This is what survives
   the annotated line *itself* being edited — adding a parameter defeats the
   snippet, but the function is still the function.
4. **Unanchored.** Give up.

Rules:

- An implementation that cannot place a note MUST NOT fall back to the raw `line`
  for display. Showing a note beside unrelated code is the failure this ordering
  exists to prevent. It MUST NOT delete the note either — it SHOULD surface it as
  unanchored and let a human re-attach it.
- When two candidate lines match at equal distance from the hint, an
  implementation SHOULD prefer the later one. Insertions above a note are more
  common than deletions.
- Symbol matching SHOULD accept a dotted path (`Class.method`). If the path no
  longer resolves, an implementation MAY match on the final segment alone, but
  MUST NOT do so when more than one symbol carries that name.
- Anchors MAY be rewritten as code moves. An implementation MUST NOT rewrite an
  anchor it inferred by guessing — only one it tracked through the edits that
  moved it. Rewriting a guess silently re-points notes at unrelated code.

---

## 7. Version control

`.lore/notes/` is committed. `.lore/local/` is not.

One file per note is deliberate: two people annotating the same source file
produce no merge conflict, because they touch different files. Only a genuine
conflict — two edits to the same note — conflicts, which is correct.

Implementations MUST NOT introduce an index, lockfile, or manifest. Any file that
every note write must also touch reintroduces the conflicts this layout avoids.

---

## 8. Conformance

A **reader** MUST:

- read `.md` files from both `.lore/notes/` and `.lore/local/`, deriving scope
  from the directory
- apply the defaults and coercions in §4
- treat a note it cannot parse as absent, without failing on the rest
- resolve `path` inheritance as in §5

A **writer** MUST additionally:

- preserve unknown frontmatter keys
- write `path` as a repository-relative POSIX path
- ensure `.lore/local/` is version-control-ignored before writing a personal note

An implementation MAY ignore §6 entirely — anchoring matters only to tools that
display notes against live code.

---

## 9. Not in version 1.0

Named so they read as deliberate omissions, and so a later version can add them
without contradiction:

- Threaded replies. Append to the body; version control holds the history.
- Cross-references between notes.
- Subdirectories under `notes/` and `local/`.
- Any organisation- or user-level scope beyond the two directories.
- Attachments. Reference files by relative path from the repository root.
- A stable identity independent of filename.

---

## 10. Changes

| Version | Date | |
|---|---|---|
| 1.0 | 2026-07-28 | First published specification. |

Additive changes — new `type` values, new optional fields — are minor versions.
Anything that changes how an existing document is interpreted is a major version.
