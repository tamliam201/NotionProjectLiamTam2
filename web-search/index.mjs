#!/usr/bin/env node
/**
 * web-search - a minimal MCP server. stdio transport, zero dependencies.
 *
 * Speaks JSON-RPC 2.0 over stdin/stdout, one JSON object per line, which is
 * all the MCP stdio transport is. Logging goes to stderr only: anything
 * written to stdout that is not a JSON-RPC message corrupts the stream.
 *
 * Tools:
 *   web_search(query, count)   -> titles/urls/snippets from DuckDuckGo's
 *                                 no-JavaScript HTML endpoint
 *   fetch_page(url, max_chars) -> a page's visible text, tags stripped
 */

const PROTOCOL_VERSION = "2025-06-18";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const log = (...a) => console.error("[web-search]", ...a);

// ---------------------------------------------------------------- tools ----

const TOOLS = [
  {
    name: "web_search",
    description:
      "Search the live web via DuckDuckGo and return ranked results as " +
      "title, URL, and snippet. Use for current information, for facts not " +
      "present in local files, and for corroborating a claim against an " +
      "outside source.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        count: {
          type: "number",
          description: "How many results to return (1-10, default 5).",
          minimum: 1,
          maximum: 10,
          default: 5,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch_page",
    description:
      "Fetch one web page and return its visible text with HTML markup " +
      "removed. Use after web_search when a snippet is not enough.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL." },
        max_chars: {
          type: "number",
          description: "Truncate the text at this length (default 6000).",
          default: 6000,
        },
      },
      required: ["url"],
    },
  },
];

// DuckDuckGo wraps every outbound link as /l/?uddg=<encoded>. Unwrap it.
function unwrap(href) {
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      /* fall through to the raw href */
    }
  }
  return href.startsWith("//") ? "https:" + href : href;
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, String.fromCharCode(34))
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/[ \t ]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

// Primary backend: DuckDuckGo's "lite" endpoint, the plain-HTML page it
// serves to browsers without JavaScript. Results are a flat table of
// <a class='result-link'> anchors each followed by a result-snippet cell.
async function searchDuckDuckGo(query, n) {
  const res = await fetch(
    "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(query),
    {
      headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(20000),
    }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  const links = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g)];
  if (!links.length) throw new Error("no result markup (DuckDuckGo served a challenge page)");

  return links.slice(0, n).map((m, i) => ({
    title: stripTags(m[2]),
    url: unwrap(m[1]),
    snippet: snippets[i] ? stripTags(snippets[i][1]) : "",
  }));
}

// Fallback backend: Wikipedia's official search API. DuckDuckGo rate-limits
// by IP and answers with a challenge page when it does, so without a fallback
// the tool would simply dead-end. Narrower than web search, but keyless,
// stable, and well suited to coursework questions.
async function searchWikipedia(query, n) {
  const url =
    "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json" +
    `&srlimit=${n}&srsearch=` + encodeURIComponent(query);
  const res = await fetch(url, {
    headers: { "user-agent": "coursework-mcp-web-search/1.0" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data?.query?.search || []).map((r) => ({
    title: r.title,
    url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(r.title.replace(/ /g, "_")),
    snippet: stripTags(r.snippet || ""),
  }));
}

async function webSearch({ query, count = 5 }) {
  if (typeof query !== "string" || !query.trim()) throw new Error("query is required");
  const n = Math.max(1, Math.min(10, Number(count) || 5));
  log(`web_search ${JSON.stringify(query)} count=${n}`);

  // Set WEB_SEARCH_BACKEND=wikipedia to skip DuckDuckGo entirely.
  if (process.env.WEB_SEARCH_BACKEND === "wikipedia") {
    const only = await searchWikipedia(query, n);
    log(`web_search -> ${only.length} results via Wikipedia (forced)`);
    return formatResults(query, only, "Wikipedia");
  }

  let results = [];
  let source = "DuckDuckGo";
  try {
    results = await searchDuckDuckGo(query, n);
  } catch (e) {
    log(`DuckDuckGo failed (${e.message}); falling back to Wikipedia`);
    results = await searchWikipedia(query, n);
    source = "Wikipedia (DuckDuckGo was unavailable)";
  }

  log(`web_search -> ${results.length} results via ${source}`);
  return formatResults(query, results, source);
}

function formatResults(query, results, source) {
  if (!results.length) return `No results for "${query}".`;
  return (
    `Web results for "${query}" - ${results.length} via ${source}:\n\n` +
    results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n")
  );
}

async function fetchPage({ url, max_chars = 6000 }) {
  if (!/^https?:\/\//i.test(String(url))) throw new Error("url must be http(s)");
  log(`fetch_page ${url}`);
  const res = await fetch(url, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const text = stripTags(await res.text());
  const cap = Number(max_chars) > 0 ? Math.floor(Number(max_chars)) : 6000;
  const note = text.length > cap ? `, truncated to ${cap}` : "";
  return `Text of ${url} (${text.length} chars${note}):\n\n${text.slice(0, cap)}`;
}

// ------------------------------------------------------------- protocol ----

async function handle(msg) {
  switch (msg.method) {
    case "initialize":
      return {
        protocolVersion: msg.params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "web-search", version: "1.0.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const { name, arguments: args = {} } = msg.params || {};
      const fn = { web_search: webSearch, fetch_page: fetchPage }[name];
      if (!fn) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      try {
        return { content: [{ type: "text", text: await fn(args) }], isError: false };
      } catch (e) {
        log("tool error:", e.message);
        // Tool failures come back as isError results, not JSON-RPC errors, so
        // the model can see what went wrong and try something else.
        return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
      }
    }
    default:
      return null; // signals "method not found"
  }
}

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log("dropped non-JSON line");
      continue;
    }
    // Notifications (no id) get no response, by the JSON-RPC spec.
    const isNotification = msg.id === undefined || msg.id === null;

    handle(msg)
      .then((result) => {
        if (isNotification) return;
        if (result === null) {
          send({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: `Method not found: ${msg.method}` },
          });
        } else {
          send({ jsonrpc: "2.0", id: msg.id, result });
        }
      })
      .catch((e) => {
        if (isNotification) return;
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: e.message } });
      });
  }
});

process.stdin.on("end", () => process.exit(0));
log("running on stdio");
