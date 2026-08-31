# document-text — reading PDF and PPTX as text

One file, `index.mjs`. Node 18+. Runs on the stdio transport, same as
`web-search`.

## Why this exists

The filesystem server returns the bytes on disk. Ask it for a PDF and you get
this, which is worse than useless — it costs context and says nothing:

```
%PDF-1.7
1 0 obj
<</Type/Catalog/Pages 2 0 R/Lang(en-US) /StructTreeRoot 55 0 R...
```

A `.pptx` is worse still: it's a ZIP, so the response is binary noise. In the
HSTAS 211 folder that covered **66 of 100 files** — every lecture deck, every
handout, the syllabus, and every primary source reading. The assistant could
find those files by name and could not read a word inside them.

## Tools

| Tool | Arguments | Returns |
|---|---|---|
| `read_document` | `path` (required), `max_chars` (default 20000), `offset` (default 0) | the text, with `--- Page N ---` / `--- Slide N ---` markers |
| `document_info` | `path` (required) | page/slide count, extracted character count, whether a text layer exists |
| `search_documents` | `query` (required), `path`, `max_results` (default 30), `regex` (default false) | matching lines with file and page/slide number |

`search_documents` is the one with no equivalent elsewhere in the bundle. The
filesystem server's `search_files` matches **filenames**; this searches the
**text inside** every PDF and PPTX under a folder.

## Scope

Takes the allowed root as `argv[2]`, exactly like the filesystem server, and
re-checks every path against it:

```
node index.mjs "C:\Users\you\coursework"
```

This process reads from disk on its own, so giving it a wider root would
quietly undo the filesystem server's scoping — the narrow root would still be
displayed by `list_allowed_directories` while this server read anything.
`setup.mjs` passes both servers the same folder. Paths are resolved with
`realpath` before the check, so a symlink inside the root cannot point out of
it.

## How each format is parsed

**PPTX — no dependency.** A `.pptx` is a ZIP of XML. The ZIP central directory
is walked directly and entries are inflated with `node:zlib`, then slide text
is read from `<a:t>` runs, one line per `<a:p>` paragraph.

Two details that are easy to get wrong:

- **Slide order comes from `ppt/presentation.xml`**, not from the `slideN.xml`
  filenames. Reordering or deleting a slide in PowerPoint leaves the file
  numbers untouched, so sorting by filename misreports "slide 7".
- **Speaker notes are found through each slide's `_rels`**, not by assuming
  `notesSlide7.xml` belongs to `slide7.xml`. It often doesn't.

**PDF — `pdfjs-dist`, pinned.** Text is pulled per page via `getTextContent()`.
`standardFontDataUrl` is set so pdfjs can find its font metrics; without it,
every page logs a warning. The loading task is kept so teardown can call
`task.destroy()` — in pdfjs 6 the document proxy has no `destroy()` of its own.

## Scanned PDFs

Some PDFs are photographs of book pages. Whether they're readable depends
entirely on whether someone ran OCR before distributing them:

- **With an OCR layer** — extraction works. Expect OCR artifacts (`THIE` for
  `THE`), which are fine for search and quotation but not for exact
  transcription.
- **Without one** — extraction returns nothing, and `read_document` says so
  explicitly rather than returning an empty string. That distinction matters:
  an empty response reads as "this document is blank" and invites the model to
  fill the gap from memory.

Detection is a density check — under ~20 characters per page is treated as no
text layer. There is no OCR here. A PDF with no text layer needs its pages
rendered to images and read visually, which this server does not do.

## Caching

Parsing every document in a coursework folder takes long enough to matter, so
results are cached in `document-text/.cache.json`, keyed by path + mtime +
size. Edit a file and it reparses; otherwise it's parsed once, ever. The cache
is gitignored and safe to delete.

`search_documents` also carries a 40-second budget. On a cold cache across a
large folder it stops early and says how many documents it did not reach
rather than exceeding the client's call timeout with nothing to show. The
cache persists, so calling again resumes.

## Notes on the implementation

The same stdio rules as `web-search` apply — everything on stdout must be a
JSON-RPC message. This server goes one step further and reassigns
`console.log` to stderr at startup, because pdfjs routes some of its warnings
through it. One stray line there corrupts the stream and the client drops the
server with no useful error.
