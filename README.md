# Lore

**Your codebase remembers.**

Notes that live beside your code instead of inside it — and that AI coding agents
read before they touch a file.

---

## The problem

Some things about code can't go in the code.

```python
# TODO: don't change this query because it breaks the finance pipeline
# need to rewrite after migration, ask Sarah
# (this comment is now 8 months old and Sarah left)
```

Comments like this get committed, pollute diffs, drift out of date, and get
deleted by the next agent that rewrites the file. So most of this knowledge never
gets written down at all — it lives in one person's head until they leave.

Lore puts it somewhere else: `.lore/*.md`, next to the repository rather than
inside the source.

## What it looks like

Notes appear at the end of the line they annotate, with a mark on the overview
ruler. Nothing is added to your source file.

```python
def divide(self, a, b):
    if b == 0:
        return "Error"          ● Kept as a string for the legacy Android client
```

Hover for the full note. Click it in the sidebar to jump to the code.

## Notes stay attached

The hard part isn't showing notes, it's keeping them attached while you work.
Lore tracks a note through four fallbacks, in order:

1. The exact line it was written against, wherever that line moved to
2. Anywhere else in the file
3. The enclosing function or class — so it survives the annotated line being *edited*
4. Failing all that, it goes to an **Unanchored** list rather than being deleted or
   silently pointed at the wrong code

While a file is open, notes move with your edits the way breakpoints do. Editing
the line a note is on does not detach it.

## Personal and team notes

A note's scope is the directory it lives in. There is no permissions system.

| | Where | |
|---|---|---|
| 🟢 **Personal** | `.lore/local/` | gitignored automatically, never leaves your machine |
| 🔵 **Team** | `.lore/notes/` | committed, travels with the repo, arrives on `git pull` |

Right-click a note to move it between the two.

## AI agents read the same notes

This is the part comments can't do. Notes are supplied to coding agents as
context, so a workaround stays a workaround instead of being "fixed".

**Claude Code** — notes arrive automatically before the agent reads or edits a file:

```
/plugin marketplace add iamrobins/lore
/plugin install lore@lore
```

**Codex, Cursor, Cline, Zed** — anything that speaks MCP:

```json
{ "mcpServers": { "lore": { "command": "npx", "args": ["-y", "lore-mcp"] } } }
```

Three tools: `lore_read` (a file's notes plus its folders' and the repo's),
`lore_search`, `lore_write`.

Set a note's type to `ai-instruction` and it reads as a rule rather than a remark.

## The format is plain Markdown

One file per note. Readable, diffable, and usable without this extension —
which is the point.

```markdown
---
path: src/payment/service.py
symbol: PaymentService.charge_customer
line: 128
snippet: "async def charge_customer(amount: int, retries: int = 3):"
type: ai-instruction
---

# Payment retry loop

Never remove the retry loop — it works around a Stripe timeout bug.
Remove only after ticket #841.
```

`path` can be a file, a folder (`src/api/`), or `.` for the whole repository.
Folder notes apply to everything beneath them.

The format is specified in **[spec/lore-format.md](spec/lore-format.md)** — it is
the authority, and this extension is one implementation of it. If you want to
read or write Lore notes from another editor, a CLI, or CI, that document is all
you need.

## Commands

| | |
|---|---|
| `Alt+N` | New note on the line under the cursor |
| Sidebar **+** | Same thing |
| Right-click a note | Open, re-attach, share with team, make personal |

## Status

Early but working and dogfooded. The format is stable; the extension is one
implementation of it.

Not built yet: note search, resolving notes, threaded replies, and multi-root
workspaces. These are deliberate omissions rather than oversights — see the
issues, and say if you want one.

## Licence

MIT
