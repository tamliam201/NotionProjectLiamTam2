#!/usr/bin/env node
/**
 * Pre-parse every .pdf and .pptx under the coursework root so the first
 * search_documents call in a chat is instant instead of spending its whole
 * time budget on a cold cache.
 *
 *   node warm-cache.mjs
 *
 * Optional - the server builds the same cache on demand. Worth running before
 * a demo, or after adding a batch of new files.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = join(HERE, "local-paths.json");
if (!existsSync(STATE)) {
  console.log(`\nNo local-paths.json. Run setup first:\n  node "${join(HERE, "setup.mjs")}" --coursework "<folder>"\n`);
  process.exit(1);
}
const paths = JSON.parse(readFileSync(STATE, "utf8"));
if (!paths.dtEntry) {
  console.log("\ndocument-text is not registered. Re-run setup.mjs.\n");
  process.exit(1);
}

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      walk(full, out);
    } else if ([".pdf", ".pptx"].includes(extname(e.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(paths.coursework);
console.log(`\nWarming ${files.length} document(s) under ${paths.coursework}\n`);

const child = spawn(paths.node, [paths.dtEntry, paths.coursework], { stdio: ["pipe", "pipe", "ignore"] });
const pending = new Map();
let buf = "", id = 0;
child.stdout.setEncoding("utf8");
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
const send = (method, params) => new Promise((r) => {
  const myId = ++id; pending.set(myId, r);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
});

await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "warm", version: "1.0.0" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const started = Date.now();
let done = 0, empty = 0;
for (const f of files) {
  const r = await send("tools/call", { name: "document_info", arguments: { path: f } });
  const text = (r.result?.content || []).map((c) => c.text).join("\n");
  done++;
  const noLayer = /text layer: NONE/.test(text);
  if (noLayer) empty++;
  const chars = /text:\s+(\d+)/.exec(text)?.[1] ?? "?";
  process.stdout.write(`  [${String(done).padStart(3)}/${files.length}] ${noLayer ? "NO TEXT LAYER" : String(chars).padStart(7) + " chars"}  ${f.slice(paths.coursework.length + 1)}\n`);
}

child.kill();
console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s. ${done} cached, ${empty} with no text layer.`);
console.log(`Cache: ${join(HERE, "document-text", ".cache.json")}\n`);
process.exit(0);
