---
name: read
description: Open a PDF (paper, thesis, dissertation, report) in Margin Reader, a local browser reader with Claude in a side panel that explains selected text or the current page, plus colour highlights, comments, and saving an annotated copy. Use when the user wants to read, study, annotate, or have a PDF explained side by side.
argument-hint: <path/to/file.pdf> [--model sonnet|opus|haiku]
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/server.mjs" *), Bash(node ${CLAUDE_SKILL_DIR}/server.mjs *), Glob
---

# Margin Reader

Margin Reader opens a PDF in the user's browser: the document on the left, Claude on the right. It runs a small local server (Node, no dependencies) bound to 127.0.0.1. Questions asked in the reader are answered by the user's own Claude Code through `claude -p`, so no API key is needed and usage counts against their normal Claude Code plan.

## Steps

1. **Find the PDF.** Use the path in `$ARGUMENTS` if one is given. Otherwise look for PDFs in the current directory with Glob (`**/*.pdf`, shallow first). If there is exactly one, use it; if there are several, ask which one; if none, ask for a path.

2. **Start the reader.** Run this exact command with the Bash tool, in the foreground, without `nohup`, `&` or any other wrapper. It starts the server in the background itself, prints the link and returns within a few seconds:

   ```bash
   node "${CLAUDE_SKILL_DIR}/server.mjs" "<absolute path to the pdf>" --detach
   ```

   Add `--model <name>` only if the user asked for a specific model, and `--no-open` if they don't want the browser opened automatically.

3. **Report the link.** The output has a `URL:` line (it includes an access token). Tell the user in two or three short lines:
   - the URL (the browser should already have opened it),
   - that highlights and comments are saved next to the PDF as `<file>.pdf.margin.json`,
   - that **Save PDF** writes `<file> (highlighted).pdf` next to the original.

4. **Stopping.** The reader stops by itself after 4 hours without use. To stop it sooner, run the same command with `--stop` in place of `--detach`. Running `--detach` again for the same PDF replaces the old server.

## What the reader does

- Select text → **Explain**, **Simpler**, **Ask about this**, **Comment**, or a highlight colour.
- **Explain page N** sends the page text and an image of the page (for figures and equations).
- Highlights tab: filter by colour, jump to a highlight, **Summarize highlights**.
- **Save PDF** embeds highlights and comments as standard PDF annotations (Acrobat, Preview, Zotero can read and edit them).

## Troubleshooting

- `Couldn't start Claude Code`: the `claude` command is not on PATH for the server. Restart with `--claude /full/path/to/claude`.
- Port in use: add `--port 0` (random free port; this is the default) or a specific `--port 8765`.
- Blank page or "PDF engine didn't load": the reader loads pdf.js, pdf-lib and marked from public CDNs (cdnjs, jsDelivr), so it needs internet access.
- Scanned PDFs have no selectable text; **Explain page** still works through the page image.
