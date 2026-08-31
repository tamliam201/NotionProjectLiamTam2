#!/usr/bin/env node
/**
 * Portable health check. Same idea as preflight.mjs, but it derives every path
 * from its own location plus local-paths.json, so it works on any machine
 * setup.mjs has run on.
 *
 *   node verify.mjs
 *
 * Exits 0 only if both servers are healthy.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, extname, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = join(HERE, "local-paths.json");

if (!existsSync(STATE)) {
  console.log(`\nNo local-paths.json here. Run setup first:\n`);
  console.log(`  node "${join(HERE, "setup.mjs")}" --coursework "<your coursework folder>"\n`);
  process.exit(1);
}
const paths = JSON.parse(readFileSync(STATE, "utf8"));

let pass = 0, fail = 0, warn = 0;
const show = (tag, label, detail) => {
  console.log(`  ${tag}  ${label}`);
  if (detail) console.log(`        ${String(detail).replace(/\n/g, "\n        ").slice(0, 400)}`);
};
const check = (label, good, detail) => { good ? (pass++, show("PASS", label, detail)) : (fail++, show("FAIL", label, detail)); };
const warned = (label, detail) => { warn++; show("WARN", label, detail); };

function connect(command, args) {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let buf = "", id = 0;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  child.stderr.resume();
  const send = (method, params) =>
    new Promise((res, rej) => {
      const myId = ++id;
      const t = setTimeout(() => rej(new Error(`timed out on ${method}`)), 30000);
      pending.set(myId, (m) => { clearTimeout(t); res(m); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    });
  return { child, send, notify: (m) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: m }) + "\n") };
}

async function open(command, args) {
  const c = connect(command, args);
  const init = await c.send("initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "1.0.0" },
  });
  c.notify("notifications/initialized");
  return { ...c, serverInfo: init.result?.serverInfo };
}
const textOf = (r) => (r.result?.content || []).map((x) => x.text ?? "").join("\n");

/** First file with the given extension under dir, as a root-relative path. */
function findOne(dir, ext, root = dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const hit = findOne(full, ext, root);
      if (hit) return hit;
    } else if (extname(e.name).toLowerCase() === ext) {
      return relative(root, full);
    }
  }
  return null;
}

console.log("\n[1] Registration");
if (existsSync(paths.configPath)) {
  const names = Object.keys(JSON.parse(readFileSync(paths.configPath, "utf8")).mcpServers || {});
  check("config present", true, paths.configPath);
  check("coursework-files registered", names.includes("coursework-files"));
  check("web-search registered", names.includes("web-search"));
  check("document-text registered", names.includes("document-text"));
} else if (platform() === "win32") {
  warned("config absent — expected while Claude Desktop is closed",
    "On Windows the app deletes this file on exit and restores it on launch. Re-run with the app open to confirm registration.");
} else {
  check("config present", false, `${paths.configPath} not found — re-run setup.mjs`);
}

console.log("\n[2] Filesystem server");
{
  const s = await open(paths.node, [paths.fsEntry, paths.coursework]);
  const tools = (await s.send("tools/list", {})).result.tools;
  check(`handshake (${s.serverInfo?.name}, ${tools.length} tools)`, tools.length > 0);

  const badInput = tools.filter((t) => t.inputSchema?.type !== "object" || !t.inputSchema?.properties);
  check("inputSchema well-formed (zod@3 override intact)", badInput.length === 0,
    badInput.length ? `${badInput.length}/${tools.length} malformed. Delete node_modules + package-lock.json and re-run setup.` : null);

  const withOutput = tools.filter((t) => t.outputSchema);
  check("no outputSchema (version pin intact)", withOutput.length === 0,
    withOutput.length ? "server-filesystem must be pinned to exactly 2025.8.21" : null);

  const allowed = textOf(await s.send("tools/call", { name: "list_allowed_directories", arguments: {} }));
  check("scoped to the coursework folder only", allowed.includes(paths.coursework), allowed.trim());

  const outside = join(paths.coursework, "..", "definitely-not-allowed.txt");
  const denied = await s.send("tools/call", { name: "read_text_file", arguments: { path: outside } });
  check("refuses paths outside the root", denied.result?.isError === true, textOf(denied).trim());

  s.child.kill();
}

console.log("\n[3] Web-search server");
{
  const s = await open(paths.node, [paths.wsEntry]);
  const tools = (await s.send("tools/list", {})).result.tools;
  check(`handshake (${s.serverInfo?.name}, ${tools.length} tools)`, tools.length === 2);
  const r = await s.send("tools/call", { name: "web_search", arguments: { query: "model context protocol", count: 3 } });
  const t = textOf(r);
  check("returns live results", !r.result?.isError && /^\s*1\./m.test(t), t.split("\n").slice(0, 3).join("\n"));
  if (/via Wikipedia/.test(t)) console.log("        NOTE: answered via the Wikipedia fallback — DuckDuckGo is throttling. Not a failure.");
  s.child.kill();
}

console.log("\n[4] Document-text server");
if (!paths.dtEntry) {
  warned("document-text not in local-paths.json — re-run setup.mjs to register it");
} else {
  const s = await open(paths.node, [paths.dtEntry, paths.coursework]);
  const tools = (await s.send("tools/list", {})).result.tools;
  check(`handshake (${s.serverInfo?.name}, ${tools.length} tools)`, tools.length === 3);

  const badInput = tools.filter((t) => t.inputSchema?.type !== "object" || !t.inputSchema?.properties);
  check("inputSchema well-formed", badInput.length === 0,
    badInput.length ? `${badInput.length}/${tools.length} malformed` : null);

  // Assert on the extracted words, not just on a non-error reply: a broken
  // parser returns an empty string perfectly successfully.
  const pptx = findOne(paths.coursework, ".pptx");
  if (pptx) {
    const r = await s.send("tools/call", { name: "read_document", arguments: { path: pptx, max_chars: 4000 } });
    const t = textOf(r);
    check("extracts text from .pptx", !r.result?.isError && /--- Slide 1 ---/.test(t) && t.length > 300,
      `${basename(pptx)} -> ${t.length} chars`);
  } else warned("no .pptx under the coursework root to test against");

  const pdf = findOne(paths.coursework, ".pdf");
  if (pdf) {
    const r = await s.send("tools/call", { name: "read_document", arguments: { path: pdf, max_chars: 4000 } });
    const t = textOf(r);
    check("extracts text from .pdf", !r.result?.isError && /--- Page 1 ---/.test(t) && t.length > 300,
      `${basename(pdf)} -> ${t.length} chars`);
  } else warned("no .pdf under the coursework root to test against");

  const denied = await s.send("tools/call", { name: "read_document", arguments: { path: join("..", "definitely-not-allowed.pdf") } });
  check("refuses paths outside the root", denied.result?.isError === true, textOf(denied).trim());

  s.child.kill();
}

console.log(`\n${pass} passed, ${fail} failed${warn ? `, ${warn} warning${warn > 1 ? "s" : ""}` : ""}.\n`);
if (fail) { console.log("Fix the FAIL lines above.\n"); process.exit(1); }
console.log("All three servers healthy. Restart Claude Desktop if you have not since setup,");
console.log("then ask a new chat: \"What files do you have access to?\"\n");
process.exit(0);
