# web-search — a minimal MCP server

One file, `index.mjs`, ~230 lines, no dependencies. Node 18+ (uses global
`fetch` and `AbortSignal.timeout`). Runs on the stdio transport.

## Why this exists rather than an off-the-shelf server

Two published, keyless search servers were installed and tested first, and
both were broken as of 2026-08-30:

| Package                        | Result                                                  |
|--------------------------------|---------------------------------------------------------|
| `duckduckgo-mcp-server@0.1.2`  | every search returns *"DDG detected an anomaly"* — its `duck-duck-scrape` dependency is blocked by DuckDuckGo |
| `@shelm/wikipedia-mcp-server@1.0.1` | every tool throws `wiki.search is not a function` on Node 24 (ESM interop) |

Both were uninstalled. The remaining published options need an API key
(Brave, Tavily, Exa) or a Python runtime, neither of which is available here.

## Tools

| Tool | Arguments | Returns |
|------|-----------|---------|
| `web_search` | `query` (required), `count` (1–10, default 5) | numbered results: title, URL, snippet |
| `fetch_page` | `url` (required), `max_chars` (default 6000) | the page's visible text, markup stripped |

## Search backends

`web_search` calls `https://lite.duckduckgo.com/lite/` — the plain-HTML page
DuckDuckGo serves to browsers without JavaScript — and parses the
`result-link` / `result-snippet` markup.

DuckDuckGo rate-limits by IP and answers with a challenge page when it does.
When that happens the parse finds no results and the server falls back to
Wikipedia's official search API (`en.wikipedia.org/w/api.php`), which is
keyless and stable. The response says which backend answered, so a
degraded result never passes itself off as a full web search.

Set `WEB_SEARCH_BACKEND=wikipedia` to skip DuckDuckGo entirely. That exists
so the fallback path can be exercised on demand instead of only when
DuckDuckGo happens to be throttling.

## Registration

In `%APPDATA%\Claude\claude_desktop_config.json`:

```json
"web-search": {
  "command": "<absolute path to node>",
  "args": ["<absolute path to this bundle>/web-search/index.mjs"]
}
```

Claude Desktop must be fully quit (tray icon included) and reopened for a
config change to take effect.

**The config file only exists while the app is running.** Observed
2026-08-30: the app deletes it on exit and writes it back on launch,
carrying the `mcpServers` block across — an entry added while the app was
running survived a full quit and relaunch, verified end to end. Edit it with
the app open. `../setup.mjs` re-applies this entry idempotently
and backs up first.

## Verifying it

```
node verify.mjs
```

Starts every server the same way the client does, handshakes, and prints
each one's tool list. It uses the live config when that file is present and
falls back to built-in specs when it is not, so it works with the app open
or closed and says which source it used.

## Notes on the implementation

- Everything on **stdout** must be a JSON-RPC message. All logging goes to
  stderr; a stray `console.log` corrupts the stream and the client drops the
  server with no useful error.
- Requests without an `id` are notifications and get no reply, per JSON-RPC.
  `notifications/initialized` is the one the client always sends.
- A failing tool returns `isError: true` with the message as text, not a
  JSON-RPC error. The model sees what went wrong and can adapt; a protocol
  error is invisible to it.
- Unknown methods return `-32601`, which is what lets a client probe for
  capabilities this server does not implement (resources, prompts) without
  the connection dying.
