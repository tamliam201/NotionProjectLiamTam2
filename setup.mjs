#!/usr/bin/env node
/**
 * One-command setup for this MCP server bundle on a new machine.
 *
 *   node setup.mjs --coursework "D:\school\coursework"
 *   node setup.mjs --coursework ~/school/coursework
 *
 * Cross-platform on purpose: Node is a prerequisite anyway, so this is one
 * script instead of a .ps1 and a .sh that drift apart.
 *
 * What it does:
 *   1. checks Node version
 *   2. resolves the coursework folder you name
 *   3. npm install (reproduces the exact pinned tree - see NOTES below)
 *   4. starts both servers and handshakes, before touching any config
 *   5. backs up and merges two entries into claude_desktop_config.json
 *   6. writes local-paths.json so verify.mjs knows where things landed
 *
 * Flags:
 *   --coursework <path>   required; the folder the filesystem server may read
 *   --dry-run             do everything except write the config
 *   --skip-install        reuse an existing node_modules
 *
 * NOTES on the two pins in package.json - do not remove either:
 *   - server-filesystem is pinned to 2025.8.21 because later versions attach a
 *     draft-07 outputSchema the client rejects at dispatch time.
 *   - zod is overridden to 3.x because the server's zod-to-json-schema@3 cannot
 *     introspect a zod 4 schema and silently emits an inputSchema with no type
 *     and no properties, which makes the app refuse to start the server.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const DRY = flag("dry-run");
let problems = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const info = (m) => console.log(`        ${m}`);
const bad = (m) => { problems++; console.log(`  ERROR ${m}`); };

console.log(`\nMCP server setup — ${platform()}, Node ${process.version}\n`);

// ------------------------------------------------------------- 1. node ----
{
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) {
    bad(`Node ${process.version} is too old. The web-search server needs 18+ (global fetch).`);
    process.exit(1);
  }
  ok(`Node ${process.version}`);
}

// ------------------------------------------------------- 2. coursework ----
let coursework = value("coursework");
if (!coursework) {
  console.log("\nMissing --coursework.\n");
  console.log("  node setup.mjs --coursework \"D:\\school\\coursework\"");
  console.log("\nThat folder is the ONLY thing the filesystem server will be able to read.");
  console.log("Point it at a folder holding just your course material — not your home");
  console.log("directory, not Downloads, not Documents.\n");
  process.exit(1);
}
if (coursework.startsWith("~")) coursework = join(homedir(), coursework.slice(1));
coursework = resolve(coursework);

if (!existsSync(coursework)) {
  bad(`coursework folder not found: ${coursework}`);
  process.exit(1);
}
if (!statSync(coursework).isDirectory()) {
  bad(`not a directory: ${coursework}`);
  process.exit(1);
}
// A scope this broad is almost certainly a mistake worth stopping for.
for (const risky of [homedir(), join(homedir(), "Downloads"), join(homedir(), "Documents"), join(homedir(), "Desktop")]) {
  if (coursework.toLowerCase() === risky.toLowerCase()) {
    bad(`refusing to scope the server to ${coursework}.`);
    info("Everything in that folder would become readable by any chat. Use a");
    info("folder holding only course material — the whole value of the");
    info("allowed-directory root is that it is narrow.");
    process.exit(1);
  }
}

ok(`coursework folder: ${coursework}`);

// ---------------------------------------------------------- 3. install ----
const FS_ENTRY = join(HERE, "node_modules", "@modelcontextprotocol", "server-filesystem", "dist", "index.js");
const WS_ENTRY = join(HERE, "web-search", "index.mjs");

if (!existsSync(WS_ENTRY)) {
  bad(`missing ${WS_ENTRY} — copy the whole bundle folder, not just setup.mjs`);
  process.exit(1);
}

if (flag("skip-install")) {
  ok("skipping npm install (--skip-install)");
} else {
  console.log("\nInstalling dependencies (this reproduces the pinned tree)...");
  // npm.cmd directly rather than shell:true, which triggers DEP0190.
  const npm = spawnSync(platform() === "win32" ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund"], {
    cwd: HERE,
    stdio: "inherit",
  });
  if (npm.status !== 0) {
    bad("npm install failed");
    process.exit(1);
  }
}
if (!existsSync(FS_ENTRY)) {
  bad(`filesystem server missing after install: ${FS_ENTRY}`);
  process.exit(1);
}
ok("dependencies installed");

// --------------------------------------------------------- 4. handshake ---
function probe(entry, extraArgs = []) {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [entry, ...extraArgs], { stdio: ["pipe", "pipe", "pipe"] });
    const pending = new Map();
    let buf = "";
    let id = 0;
    const timer = setTimeout(() => { child.kill(); resolveP({ error: "timed out" }); }, 30000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      }
    });
    child.stderr.resume();
    child.on("error", (e) => { clearTimeout(timer); resolveP({ error: e.message }); });

    const send = (method, params) =>
      new Promise((r) => {
        const myId = ++id;
        pending.set(myId, r);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
      });

    (async () => {
      const init = await send("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "setup", version: "1.0.0" },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const listed = await send("tools/list", {});
      clearTimeout(timer);
      child.kill();
      resolveP({ serverInfo: init.result?.serverInfo, tools: listed.result?.tools || [] });
    })().catch((e) => { clearTimeout(timer); child.kill(); resolveP({ error: e.message }); });
  });
}

console.log("\nStarting both servers before touching any config...");

{
  const r = await probe(FS_ENTRY, [coursework]);
  if (r.error) bad(`filesystem server: ${r.error}`);
  else {
    const badInput = r.tools.filter((t) => t.inputSchema?.type !== "object" || !t.inputSchema?.properties);
    const withOutput = r.tools.filter((t) => t.outputSchema);
    if (badInput.length) {
      bad(`filesystem server advertises ${badInput.length}/${r.tools.length} malformed inputSchemas.`);
      info("The zod override in package.json did not take. Delete node_modules and");
      info("package-lock.json, then re-run. Do not remove the override.");
    } else if (withOutput.length) {
      bad(`filesystem server attaches outputSchema to ${withOutput.length} tools — version pin slipped.`);
      info("package.json must pin server-filesystem to exactly 2025.8.21.");
    } else {
      ok(`filesystem server: ${r.tools.length} tools, schemas clean`);
    }
  }
}
{
  const r = await probe(WS_ENTRY);
  if (r.error) bad(`web-search server: ${r.error}`);
  else ok(`web-search server: ${r.tools.length} tools`);
}

if (problems) {
  console.log(`\n${problems} problem(s). Config not touched.\n`);
  process.exit(1);
}

// ------------------------------------------------------------ 5. config ---
const CONFIG_PATH =
  platform() === "win32"
    ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
    : platform() === "darwin"
    ? join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : join(homedir(), ".config", "Claude", "claude_desktop_config.json");

const entries = {
  "coursework-files": { command: process.execPath, args: [FS_ENTRY, coursework] },
  "web-search": { command: process.execPath, args: [WS_ENTRY] },
};

console.log(`\nConfig: ${CONFIG_PATH}`);

if (DRY) {
  console.log("\n--dry-run: would merge these entries:\n");
  console.log(JSON.stringify(entries, null, 2));
  process.exit(0);
}

let config = {};
if (existsSync(CONFIG_PATH)) {
  const backupDir = join(HERE, "backups");
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backup = join(backupDir, `claude_desktop_config.${stamp}.json`);
  copyFileSync(CONFIG_PATH, backup);
  ok(`backed up to ${backup}`);
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    bad(`existing config is not valid JSON (${e.message}). Fix or move it, then re-run.`);
    process.exit(1);
  }
} else {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  info("no existing config — creating one");
  if (platform() === "win32") {
    info("NOTE: on Windows this file only exists while Claude Desktop is running.");
    info("If the app is closed, start it and re-run so the merge lands on the live file.");
  }
}

config.mcpServers = Object.assign({}, config.mcpServers, entries);
writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
ok(`registered: ${Object.keys(entries).join(", ")}`);

writeFileSync(
  join(HERE, "local-paths.json"),
  JSON.stringify({ node: process.execPath, configPath: CONFIG_PATH, coursework, fsEntry: FS_ENTRY, wsEntry: WS_ENTRY }, null, 2) + "\n",
  "utf8"
);
ok("wrote local-paths.json");

console.log(`
Done. Next:

  1. Fully quit Claude Desktop (tray icon / menu bar icon included) and reopen.
     Servers are only spawned at app launch.
  2. Settings > Developer > Local MCP servers — both should read "running".
  3. node "${join(HERE, "verify.mjs")}"
  4. New chat: "What files do you have access to?"
     It should list ${coursework} and nothing else.
`);
