# What became possible

**Before.** The assistant knew nothing about HSTAS 211 unless I pasted it in. Every question
started with me being the retrieval layer: find the file, open it, copy the relevant part,
paste it. That capped questions at whatever I could hold in my head well enough to go find —
I could ask about a document, but not *across* them, because I'd have had to paste eleven PDFs
to ask a question that spanned eleven PDFs.

**After.** Three MCP servers are registered with Claude Desktop:

- **`coursework-files`** — the official filesystem server, allowed exactly one directory:
  `C:\Users\tamli\Desktop\HSTAS 211 Workflow` (Assignments, Discussions, Files, Submissions).
- **`web-search`** — a one-file, zero-dependency server providing `web_search` and
  `fetch_page`, backed by DuckDuckGo's HTML endpoint with a Wikipedia fallback.
- **`document-text`** — reads `.pdf` and `.pptx` as text, and searches inside them.

The third one exists because of something I only found by testing. The filesystem server
returns the bytes on disk, so asking it for a PDF returns `%PDF-1.7` and a list of object
dictionaries — not one readable word. For `.pptx` it returns ZIP noise. That covered **66 of
my 100 course files**: every lecture deck, every handout, the syllabus, and every primary
source reading. The assistant could locate all of them by name and could not read inside any
of them. "Connected to my files" turned out to mean far less than it sounded like until I
checked what actually came back.

The questions that now work are the cross-file ones. *"Which class handouts cover the
Ming–Qing transition, and what did I already argue about it in my discussion posts?"* touches
a dozen files across two folders and three formats. I no longer choose in advance which
documents are relevant — that's now the assistant's problem, and it's a search problem it's
better at than I am. The second server matters for the same reason in the other direction: it
can pull in a date or a name the course materials assume you already know, without me leaving
the chat.

# The request flow

Take *"What's the final paper worth?"*

1. **Launch.** Claude Desktop reads `claude_desktop_config.json` and spawns each server as a
   child process — here, `node` running the filesystem server with the coursework path as its
   only argument. It handshakes (`initialize`), then calls `tools/list`. The 14 filesystem
   tools, 2 search tools, and 3 document tools are now in the model's context as callable
   functions.
2. **Prompt.** I type the question. The model sees my text *and* those tool definitions.
3. **Tool call.** The model decides it can't answer from memory and emits a call —
   `search_files` for the syllabus, then `read_document` on the hit.
4. **Transport.** The client serializes that as JSON-RPC `tools/call` and writes it to the
   server's **stdin**. Not HTTP — a pipe to a local process.
5. **Execution.** The server checks the requested path against its allowed-directory root,
   reads the file off disk, extracts the text, and writes a JSON-RPC response to **stdout**.
   (Everything on stdout must be a protocol message; all logging goes to stderr, because one
   stray `console.log` corrupts the stream and the client silently drops the server. The PDF
   library logs warnings through `console.log`, so `document-text` reassigns it at startup.)
6. **Answer.** The client feeds the result back as a tool-result block. The model reads the
   actual syllabus text and answers, and I can check the page number it cited.

The thing worth internalizing: the model never touches my disk. It emits a *request* for a
file. A separate process I configured decides whether to honor it.

# What I deliberately did not give it access to

**The root is the coursework folder, not my Desktop and not my home directory.** This was
the actual decision, and it cost me something real — the assistant cannot see my notes app,
my other courses, or anything I download. That's the point. The whole security value of the
allowed-directory model is that the root is narrow; scoping it to `~` to save myself a
copy-paste would have converted "an assistant that can read my coursework" into "an assistant
that can read my tax returns," with no visible difference in the chat window.

This is enforced, not just intended. `setup.mjs` refuses `~`, `Downloads`, `Documents`, and
`Desktop` outright, and `verify.mjs` proves the boundary on every run by asking for a file one
level up and requiring the refusal:

```
Error: Access denied - path outside allowed directories:
C:\Users\tamli\Desktop\definitely-not-allowed.txt
  not in C:\Users\tamli\Desktop\HSTAS 211 Workflow
```

Adding the third server was where this got interesting, because `document-text` reads from
disk itself — it doesn't go through the filesystem server. Handing it a wider root would have
silently undone the whole boundary: `list_allowed_directories` would still have displayed one
narrow folder while a second process read anything on the machine. So it takes the same root
as its one argument, re-checks every path against it (resolving symlinks first), and
`verify.mjs` tests *both* servers for the refusal. The lesson generalizes: a scope is only as
narrow as the least careful process holding it.

Two smaller ones. The bundle itself lives *outside* the root, so the assistant can't read its
own config or the backups of my previous config. And the pinned filesystem server ships no
delete tool — it can read, write, edit, and move within the coursework folder, but it cannot
destroy a file there, which is the failure mode I'd least be able to notice after the fact.
