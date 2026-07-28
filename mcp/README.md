# @robinsingh/lore-mcp

Read and write [Lore](https://github.com/iamrobins/lore) notes from any AI coding agent that speaks MCP.

Lore notes are Markdown files in a repository's `.lore/` directory that record
what source comments cannot: why code is the way it is, constraints that are not
visible in the file, and instructions about how it may be changed. This server
puts them in front of the agent before it edits.

You do not need the VS Code extension. The notes are plain files and the format
is documented — this server is one way to read them, not the only one.

## Tools

| Tool | What it does |
|---|---|
| `lore_read(path)` | Notes for a file, plus its parent folders' notes and repository-wide notes, broadest first |
| `lore_search(query)` | Keyword search across note titles, bodies, paths and symbols |
| `lore_write(path, title, body, …)` | Records a new note |

`lore_write` defaults to `scope: "personal"`, which lands in the gitignored
`.lore/local/`. Passing `scope: "team"` writes to `.lore/notes/`, which is
committed — so an agent should only do that when the user asks for a note the
whole team will see.

## Install

The server reads the repository given as its first argument, falling back to
`LORE_ROOT` and then to the working directory it was launched in.

**Claude Code**

```bash
claude mcp add lore -- npx -y @robinsingh/lore-mcp
```

**Codex** — `~/.codex/config.toml`

```toml
[mcp_servers.lore]
command = "npx"
args = ["-y", "@robinsingh/lore-mcp"]
```

**Cursor, Cline, Windsurf, Zed** — `mcp.json`

```json
{
  "mcpServers": {
    "lore": { "command": "npx", "args": ["-y", "@robinsingh/lore-mcp"] }
  }
}
```

## Getting the agent to use it

Reading notes before editing is a habit worth stating explicitly. Add this to
`CLAUDE.md` or `AGENTS.md`:

```
Before editing a file, call lore_read on it. The notes there record constraints
that are not visible in the source.
```

For Claude Code there is a plugin that does this with hooks instead of relying
on the model to remember.

## Note format

One Markdown file per note, with YAML frontmatter:

```markdown
---
path: src/payment/service.py
symbol: PaymentService.charge_customer
line: 128
snippet: "async def charge_customer(amount: int, retries: int = 3):"
type: ai-instruction
status: open
created: 2026-07-28
---

# Payment retry loop

Never remove the retry loop — it works around a Stripe timeout bug.
Remove only after ticket #841.
```

`path` may be a file, a folder (`src/api/`), or `.` for the whole repository.
A note's scope is the directory it lives in: `.lore/local/` is personal and
gitignored, `.lore/notes/` is shared and committed.

Full specification:
[spec/lore-format.md](https://github.com/iamrobins/lore/blob/main/spec/lore-format.md).

## Development

```bash
npm install
npm run check    # typecheck
npm run build    # bundle to dist/server.js
```

The note store is imported from the VS Code extension's `../src/noteStore.ts`
and bundled in, so there is one implementation of the format rather than two
that drift.

## Licence

MIT
