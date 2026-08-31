#!/usr/bin/env node
/**
 * document-text - an MCP server that reads .pdf and .pptx as text.
 *
 * The filesystem server hands back whatever bytes are on disk, so a PDF
 * arrives as "%PDF-1.7" plus object dictionaries and a PPTX as ZIP noise.
 * This server extracts the actual words instead.
 *
 *   node index.mjs <allowed-root>
 *
 * Scoped exactly like the filesystem server: one allowed root, passed as
 * argv[2], and every path is resolved and re-checked against it. Widening
 * that root here would quietly undo the filesystem server's scoping, since
 * this process reads from disk on its own.
 *
 * Tools:
 *   read_document(path, max_chars, offset)  -> the document's text
 *   document_info(path)                     -> pages/slides, extracted size
 *   search_documents(query, path, ...)      -> content search across the root
 *
 * PPTX is unzipped in-process (a .pptx is a ZIP of XML, and node:zlib is
 * enough), so it adds no dependency. PDF goes through pdfjs-dist - pinned,
 * see package.json.
 *
 * Extraction is slow enough to be worth caching: results are memoised in
 * memory and persisted next to this file, keyed by path + mtime + size, so a
 * document is only ever parsed once per edit.
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, realpathSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { dirname, join, resolve, extname, relative, basename, isAbsolute, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Anything on stdout that is not a JSON-RPC message kills the connection, and
// pdfjs routes some warnings through console.log. Redirect it before it can.
console.log = (...a) => process.stderr.write(a.join(" ") + "\n");

const PROTOCOL_VERSION = "2025-06-18";
const HERE = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.error("[document-text]", ...a);

// ----------------------------------------------------------------- scope ---

const ROOT_ARG = process.argv[2];
if (!ROOT_ARG) {
  log("usage: node index.mjs <allowed-root>");
  process.exit(1);
}
let ROOT;
try {
  ROOT = realpathSync(resolve(ROOT_ARG));
} catch {
  log(`allowed root does not exist: ${ROOT_ARG}`);
  process.exit(1);
}
log(`allowed root: ${ROOT}`);

/**
 * Resolve a caller-supplied path and prove it lands inside ROOT.
 *
 * realpath is the point: comparing un-resolved strings would let a symlink
 * inside the root point anywhere on disk. Files that do not exist yet are
 * checked through their parent, so "no such file" stays distinguishable
 * from "denied".
 */
function safePath(p) {
  if (typeof p !== "string" || !p.trim()) throw new Error("path must be a non-empty string");
  const requested = resolve(ROOT, p);
  let real;
  try {
    real = realpathSync(requested);
  } catch {
    let parent;
    try {
      parent = realpathSync(dirname(requested));
    } catch {
      throw new Error(`no such file: ${requested}`);
    }
    real = join(parent, basename(requested));
  }
  const r = relative(ROOT, real);
  if (r.startsWith("..") || isAbsolute(r)) {
    throw new Error(`Access denied - path outside allowed directories: ${real} not in ${ROOT}`);
  }
  return real;
}

// ------------------------------------------------------------- pptx / zip ---

const SIG_EOCD = 0x06054b50, SIG_CEN = 0x02014b50, SIG_LOC = 0x04034b50;

/** Parse a ZIP central directory into a name -> entry map. */
function openZip(buf) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a ZIP archive (no end-of-central-directory record)");

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff) throw new Error("ZIP64 archives are not supported");

  const files = new Map();
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== SIG_CEN) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    files.set(name, { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return { buf, files };
}

function zipRead(zip, name) {
  const e = zip.files.get(name);
  if (!e) return null;
  const b = zip.buf;
  if (b.readUInt32LE(e.localOff) !== SIG_LOC) return null;
  // The local header repeats the name and extra fields, and its extra-field
  // length can differ from the central directory's - always read it here.
  const nameLen = b.readUInt16LE(e.localOff + 26);
  const extraLen = b.readUInt16LE(e.localOff + 28);
  const start = e.localOff + 30 + nameLen + extraLen;
  const data = b.subarray(start, start + e.compSize);
  if (e.method === 0) return data;
  if (e.method === 8) return inflateRawSync(data);
  throw new Error(`unsupported ZIP compression method ${e.method} for ${name}`);
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, String.fromCharCode(34)).replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

/** Text of one slide's XML, one line per <a:p> paragraph. */
function slideText(xml) {
  const out = [];
  for (const p of xml.match(/<a:p[\s>][\s\S]*?<\/a:p>/g) || []) {
    const runs = [...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1]));
    const line = runs.join("").replace(/\s+/g, " ").trim();
    if (line) out.push(line);
  }
  return out;
}

/**
 * Slide order comes from presentation.xml's <p:sldIdLst>, not from the
 * slideN.xml filenames - reordering or deleting a slide in PowerPoint leaves
 * the file numbers alone, so numeric sort would misreport "slide 7".
 */
function slideOrder(zip) {
  try {
    const pres = zipRead(zip, "ppt/presentation.xml")?.toString("utf8");
    const rels = zipRead(zip, "ppt/_rels/presentation.xml.rels")?.toString("utf8");
    if (!pres || !rels) throw new Error("no presentation part");
    const target = new Map();
    for (const m of rels.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
      target.set(m[1], m[2].replace(/^\.\.\//, "").replace(/^\/?(ppt\/)?/, ""));
    }
    const ordered = [];
    for (const m of pres.matchAll(/<p:sldId[^>]*r:id="([^"]+)"/g)) {
      const t = target.get(m[1]);
      if (t) ordered.push("ppt/" + t);
    }
    if (ordered.length) return ordered;
  } catch { /* fall through to filename order */ }
  return [...zip.files.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
}

function extractPptx(file) {
  const zip = openZip(readFileSync(file));
  const parts = [];
  let n = 0;
  for (const name of slideOrder(zip)) {
    const xml = zipRead(zip, name)?.toString("utf8");
    if (!xml) continue;
    n++;
    const lines = slideText(xml);

    // Speaker notes hang off the slide's own rels, so follow the relationship
    // rather than assuming notesSlideN pairs with slideN.
    let notes = [];
    try {
      const rel = zipRead(zip, name.replace(/([^/]+)$/, "_rels/$1.rels"))?.toString("utf8");
      const hit = rel && /Target="([^"]*notesSlide[^"]*)"/.exec(rel);
      if (hit) {
        const nx = zipRead(zip, "ppt/" + hit[1].replace(/^\.\.\//, "").replace(/^\/?(ppt\/)?/, ""))?.toString("utf8");
        if (nx) notes = slideText(nx);
      }
    } catch { /* notes are optional */ }

    parts.push(
      `--- Slide ${n} ---\n` +
      (lines.length ? lines.join("\n") : "(no text on this slide)") +
      (notes.length ? `\n[Speaker notes] ${notes.join(" ")}` : "")
    );
  }
  return { text: parts.join("\n\n"), units: n, unitName: "slides" };
}

// ------------------------------------------------------------------- pdf ---

let pdfjs = null;
const loadPdfjs = async () => (pdfjs ??= await import("pdfjs-dist/legacy/build/pdf.mjs"));

// Without this, pdfjs warns once per page that it cannot find its font metrics.
const STANDARD_FONTS = pathToFileURL(
  join(HERE, "..", "node_modules", "pdfjs-dist", "standard_fonts") + sep
).href;

async function extractPdf(file) {
  const lib = await loadPdfjs();
  // Hold the loading task, not just its promise: the task owns teardown, and
  // the document proxy has no destroy() of its own in pdfjs 6.
  const task = lib.getDocument({
    data: new Uint8Array(readFileSync(file)),
    standardFontDataUrl: STANDARD_FONTS,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    verbosity: 0,
  });
  const doc = await task.promise;

  const pages = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      let s = "";
      for (const it of tc.items) {
        s += it.str;
        if (it.hasEOL) s += "\n";
      }
      pages.push(`--- Page ${i} ---\n${s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()}`);
    }
  } finally {
    await task.destroy().catch(() => {});
  }
  return { text: pages.join("\n\n"), units: pages.length, unitName: "pages" };
}

// ----------------------------------------------------------------- cache ---

const CACHE_FILE = join(HERE, ".cache.json");
let cache = {};
try {
  if (existsSync(CACHE_FILE)) cache = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
} catch { cache = {}; }

let cacheDirty = false;
function flush() {
  if (!cacheDirty) return;
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(cache), "utf8");
    cacheDirty = false;
  } catch (e) {
    log(`could not persist cache: ${e.message}`);
  }
}

const SUPPORTED = new Set([".pdf", ".pptx"]);

/** Extract, memoised on identity + mtime + size. */
async function extract(file) {
  const ext = extname(file).toLowerCase();
  if (!SUPPORTED.has(ext)) {
    throw new Error(
      `unsupported file type "${ext || "(none)"}". This server handles .pdf and .pptx; ` +
      `read anything else with the filesystem server's read_text_file.`
    );
  }
  const st = statSync(file);
  const key = `${file}|${st.mtimeMs}|${st.size}`;
  if (cache[key]) return cache[key];

  const started = Date.now();
  const r = ext === ".pptx" ? extractPptx(file) : await extractPdf(file);

  // A PDF that is page images with no OCR layer extracts to almost nothing.
  // Say so explicitly - an empty string reads as "this document is blank" and
  // invites the model to answer from thin air.
  const dense = r.text.replace(/--- (?:Page|Slide) \d+ ---/g, "").replace(/\s/g, "").length;
  r.scanned = ext === ".pdf" && dense < Math.max(100, r.units * 20);
  r.chars = dense;
  r.ms = Date.now() - started;

  // Drop the oldest half rather than growing without bound.
  const keys = Object.keys(cache);
  if (keys.length > 400) for (const k of keys.slice(0, 200)) delete cache[k];
  cache[key] = r;
  cacheDirty = true;
  flush();
  return r;
}

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      walk(full, out);
    } else if (SUPPORTED.has(extname(e.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

// ----------------------------------------------------------------- tools ---

const TOOLS = [
  {
    name: "read_document",
    description:
      "Read a .pdf or .pptx as plain text. Use this INSTEAD OF read_text_file " +
      "for those two formats - read_text_file returns raw PDF/ZIP bytes for " +
      "them, not words. Pages and slides are labelled in the output so an " +
      "answer can cite a location. PowerPoint speaker notes are included.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to a .pdf or .pptx inside the allowed root." },
        max_chars: { type: "number", description: "Truncate at this length (default 20000).", default: 20000 },
        offset: { type: "number", description: "Skip this many characters first, to page through a long document.", default: 0 },
      },
      required: ["path"],
    },
  },
  {
    name: "document_info",
    description:
      "Page or slide count and extractable-text size for one .pdf or .pptx, " +
      "without returning the text. Use to check whether a scanned PDF has a " +
      "usable text layer before reading it.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to a .pdf or .pptx inside the allowed root." },
      },
      required: ["path"],
    },
  },
  {
    name: "search_documents",
    description:
      "Search the TEXT INSIDE every .pdf and .pptx under a folder and return " +
      "matching lines with their file and page/slide number. This is content " +
      "search, unlike the filesystem server's search_files, which matches " +
      "filenames only. The first call parses everything and can take a while; " +
      "results are cached, so later calls are fast.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to find (case-insensitive)." },
        path: { type: "string", description: "Folder to search, relative to the allowed root. Defaults to the whole root." },
        max_results: { type: "number", description: "Maximum matching lines to return (default 30).", default: 30 },
        regex: { type: "boolean", description: "Treat query as a regular expression (default false).", default: false },
      },
      required: ["query"],
    },
  },
];

const show = (f) => relative(ROOT, f) || basename(f);

async function callTool(name, args) {
  if (name === "read_document") {
    const file = safePath(args.path);
    const r = await extract(file);
    const max = Math.max(1, Number(args.max_chars ?? 20000));
    const off = Math.max(0, Number(args.offset ?? 0));
    const slice = r.text.slice(off, off + max);
    return (
      `${show(file)} - ${r.units} ${r.unitName}, ${r.chars} characters of text` +
      (r.scanned ? "\nWARNING: no usable text layer (page images without OCR). What follows will be empty or noise." : "") +
      (off + slice.length < r.text.length
        ? `\nShowing characters ${off}-${off + slice.length} of ${r.text.length}. Call again with offset=${off + slice.length} for more.`
        : "") +
      "\n\n" + slice
    );
  }

  if (name === "document_info") {
    const file = safePath(args.path);
    const r = await extract(file);
    return [
      `file:       ${show(file)}`,
      `type:       ${extname(file).toLowerCase()}`,
      `${(r.unitName + ":").padEnd(12)}${r.units}`,
      `text:       ${r.chars} characters`,
      `text layer: ${r.scanned ? "NONE - page images, no OCR" : "yes"}`,
      `parse time: ${r.ms} ms (cached after the first read)`,
    ].join("\n");
  }

  if (name === "search_documents") {
    const base = args.path ? safePath(args.path) : ROOT;
    const files = walk(base);
    if (!files.length) return `No .pdf or .pptx files under ${show(base)}.`;

    let re;
    try {
      re = new RegExp(args.regex ? args.query : String(args.query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    } catch (e) {
      throw new Error(`invalid regular expression: ${e.message}`);
    }

    const max = Math.max(1, Number(args.max_results ?? 30));
    const out = [];
    const failed = [];
    let searched = 0, skipped = 0, capped = false;
    // The first run parses every document. Stay under the client's call
    // timeout and report honestly rather than dying at 60s with nothing to
    // show; the cache persists, so calling again resumes where this stopped.
    const deadline = Date.now() + 40000;

    for (const f of files) {
      if (out.length >= max) { capped = true; break; }
      if (Date.now() > deadline) { skipped = files.length - searched; break; }
      let r;
      try { r = await extract(f); } catch (e) { failed.push(`${show(f)}: ${e.message}`); continue; }
      searched++;
      let unit = "?";
      for (const line of r.text.split("\n")) {
        const m = /^--- (?:Page|Slide) (\d+) ---$/.exec(line);
        if (m) { unit = m[1]; continue; }
        if (re.test(line)) {
          out.push(`${show(f)} [${r.unitName === "pages" ? "p. " : "slide "}${unit}]\n    ${line.trim().slice(0, 300)}`);
          if (out.length >= max) break;
        }
      }
    }

    const header =
      `${out.length} match${out.length === 1 ? "" : "es"} for "${args.query}" ` +
      `across ${searched} of ${files.length} document(s) under ${show(base)}.` +
      (capped ? `\nStopped at max_results=${max}, so later documents were not searched. Raise max_results or narrow the query to see the rest.` : "") +
      (skipped ? `\nStopped at the time limit with ${skipped} document(s) unsearched. Everything parsed so far is cached - call again to continue.` : "") +
      (failed.length ? `\nCould not read ${failed.length}: ${failed.slice(0, 3).join("; ")}` : "");
    return out.length ? `${header}\n\n${out.join("\n")}` : header;
  }

  throw new Error(`unknown tool: ${name}`);
}

// ------------------------------------------------------------- transport ---

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  // No id means a notification: per JSON-RPC it gets no reply, ever.
  if (id == null) return;

  if (method === "initialize") {
    return ok(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "document-text", version: "1.0.0" },
    });
  }
  if (method === "tools/list") return ok(id, { tools: TOOLS });
  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    try {
      return ok(id, { content: [{ type: "text", text: await callTool(name, args || {}) }] });
    } catch (e) {
      // A tool failure is a result, not a protocol error - the model can read
      // this text and adapt. A JSON-RPC error would be invisible to it.
      return ok(id, { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
    }
  }
  // Lets a client probe for resources/prompts without killing the connection.
  return fail(id, -32601, `Method not found: ${method}`);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    try { await handle(msg); } catch (e) { log(`handler crashed: ${e.stack || e.message}`); }
  }
});
process.stdin.on("end", () => { flush(); process.exit(0); });
process.on("SIGTERM", () => { flush(); process.exit(0); });
