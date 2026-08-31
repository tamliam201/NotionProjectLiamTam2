# Portable MCP server bundle

Three MCP servers, set up on a new machine with one command:

- **coursework-files** — the official filesystem server, scoped to exactly one
  folder you choose
- **web-search** — a zero-dependency search/fetch server (see
  `web-search/README.md`)
- **document-text** — reads `.pdf` and `.pptx` as text and searches inside
  them, scoped to the same folder (see `document-text/README.md`)

That third one is not optional decoration. The filesystem server returns the
bytes on disk, so a PDF comes back as `%PDF-1.7` and object dictionaries and a
`.pptx` comes back as ZIP noise — in a typical coursework folder that is most
of the files, findable by name and unreadable inside.

Copy this whole folder to the new machine. Put it anywhere — a USB stick,
Drive, a git repo, `scp`. It has no absolute paths baked in; `setup.mjs`
resolves everything at install time.

## Setup

Prerequisite: **Node 18 or newer** (`node --version`).

```
node setup.mjs --coursework "D:\school\coursework"
```

macOS / Linux:

```
node setup.mjs --coursework ~/school/coursework
```

That folder is the **only** thing the filesystem server will ever be able to
read. Point it at course material, not at your home directory — setup refuses
`~`, `Downloads`, `Documents`, and `Desktop` outright.

Then:

1. Fully quit Claude Desktop — tray icon on Windows, menu bar icon on macOS —
   and reopen. Servers are only spawned at app launch.
2. **Settings → Developer → Local MCP servers**: all three should read `running`.
3. `node verify.mjs`
4. New chat: *"What files do you have access to?"*

## Flags

| Flag | Effect |
|---|---|
| `--coursework <path>` | required; the filesystem server's one allowed root |
| `--dry-run` | everything except writing the config; still installs, since the servers have to start for their schemas to be checked |
| `--skip-install` | reuse an existing `node_modules` |

Setup backs up any existing config to `backups/` before merging, and touches
only the `mcpServers` key. Re-running is safe — it overwrites its own two
entries and leaves everything else alone.

## Do not remove the pins in package.json

```json
"dependencies": {
  "@modelcontextprotocol/server-filesystem": "2025.8.21",
  "pdfjs-dist": "6.3.289"
},
"overrides": { "zod": "3.25.76" }
```

The first two fix different bugs, and dropping either leaves the filesystem
server broken in a way that is genuinely hard to diagnose:

**The version pin.** 2025.11.25 and later attach a draft-07 `outputSchema` to
all 14 tools. The client validates output schemas as 2020-12 only, rejects
them, and every tool call fails client-side before reaching the server.

**The zod override.** The server declares `@modelcontextprotocol/sdk: ^1.17.0`,
which now resolves to an SDK built on zod 4 — but the server's own
`zod-to-json-schema@3` only understands zod 3. Handed a zod 4 schema it emits
`{"$schema": "..."}` with no `type` and no `properties`. The app validates
`tools/list`, rejects that, and shows the server as **failed** with
*"Invalid result for tools/list … path: [tools, 0, inputSchema, type]"*.
Overriding the SDK version is not enough — zod 4 still gets hoisted. Override
`zod` itself.

**The pdfjs pin** is ordinary caution rather than a known bug: pdfjs 6 moved
teardown from the document proxy to the loading task, so `doc.destroy()` — the
call every older example uses — throws `not a function`. An exact pin keeps
that class of silent API drift out of the bundle.

**The trap worth knowing about:** with broken input schemas the server still
starts, and every tool call still works when driven directly over JSON-RPC,
because it validates arguments internally rather than against what it
advertises. A smoke test that only calls tools passes while the app refuses to
load the server. `setup.mjs` and `verify.mjs` both inspect `tools/list`
specifically to catch this.

## Files

| File | Purpose |
|---|---|
| `setup.mjs` | installs, handshakes all three servers, merges the config |
| `verify.mjs` | health check — schemas, scope, refusal, live search, extraction |
| `package.json` | the pins above |
| `web-search/index.mjs` | the search server, one file, no dependencies |
| `document-text/index.mjs` | the PDF/PPTX text server |
| `warm-cache.mjs` | optional; pre-parses every document so the first search is instant |
| `document-text/.cache.json` | extracted text, keyed by mtime; safe to delete |
| `local-paths.json` | written by setup; where things landed on this machine |

`local-paths.json` and `node_modules/` are machine-specific. If you move the
bundle again, delete both and re-run `setup.mjs`.

## Adding the servers by hand instead

If you would rather not run the script, `setup.mjs --dry-run` prints the exact
JSON to paste under `mcpServers` in `claude_desktop_config.json`:

- Windows — `%APPDATA%\Claude\claude_desktop_config.json`
  (exists only while the app is running; it is deleted on exit and restored on
  launch, so edit it with the app open)
- macOS — `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux — `~/.config/Claude/claude_desktop_config.json`
