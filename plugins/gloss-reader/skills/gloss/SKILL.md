---
name: gloss
description: Open a PDF (paper, thesis, dissertation, report) in Gloss Reader, a local browser reader with an AI side panel that explains selected text or the current page, with colour highlights, comments, and saving an annotated copy. Use when the user wants to read, study, annotate, or have a PDF explained side by side.
argument-hint: "[path/to/file.pdf] [--model NAME]"
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/server.mjs" *), Bash(node ${CLAUDE_SKILL_DIR}/server.mjs *), Glob
---

# Gloss Reader

Gloss Reader opens a PDF in the user's browser with the document on the left and an AI panel on the right. A small local server (Node 18+, no dependencies, bound to 127.0.0.1) serves the page. Questions asked in the reader are answered by the user's own coding-agent CLI in non-interactive mode, so no extra API key is needed:

| Agent | CLI used | `--agent` value |
|---|---|---|
| Claude Code | `claude -p` | `claude` |
| Codex | `codex exec` | `codex` |
| Gemini CLI | `gemini -p` | `gemini` |

The server script is `server.mjs` in the same folder as this SKILL.md. In Claude Code that folder is `${CLAUDE_SKILL_DIR}`. In other agents, use the directory you loaded this file from.

## Steps

1. **Which PDF, if any.** If the user named a PDF, use its absolute path. If they didn't (for example they just typed `/gloss`), don't search for one: start the reader without a file, and they will open a PDF in the browser page.

2. **Start the reader.** Run this command in the foreground, without `nohup`, `&` or any other wrapper. It starts the server in the background itself, prints the link and returns within a few seconds:

   ```bash
   node "<skill folder>/server.mjs" "<absolute path to the pdf>" --detach --agent <you>
   ```

   Without a PDF, leave the path out:

   ```bash
   node "<skill folder>/server.mjs" --detach --agent <you>
   ```

   Set `--agent` to the agent you are: `claude` if you are Claude Code, `codex` if you are Codex, `gemini` if you are Gemini CLI. Add `--model <name>` only if the user asked for a specific model, and `--no-open` if they don't want the browser opened automatically. If your sandbox blocks network ports or background processes, ask the user to approve the command or to run it in their own terminal.

3. **Report the link.** The output has a `URL:` line that includes an access token. Tell the user in two or three short lines:
   - the URL (the browser should already have opened it); if no PDF was given, that they can drop or choose a PDF on the page,
   - where highlights and comments are saved: next to the PDF as `<file>.pdf.gloss.json`, or in `~/.gloss-reader/annotations.json` when the PDF was opened in the browser,
   - that **Save PDF** writes `<file> (highlighted).pdf` next to the original (never overwriting), or downloads it through the browser when the PDF was opened in the browser.

4. **Stopping.** The reader stops by itself after 4 hours without use. To stop it sooner, run the same command with `--stop` in place of `--detach`. Running `--detach` again for the same PDF (or again with no PDF) replaces the old server.

## What the reader does

- Select text, then choose **Explain**, **Simpler**, **Ask about this**, **Comment**, or a highlight colour.
- **Explain page N** sends the page text and an image of the page (for figures and equations).
- Highlights tab: filter by colour, jump to a highlight, **Summarize highlights**.
- **Save PDF** embeds highlights and comments as standard PDF annotations that Acrobat, Preview and Zotero can read and edit.

## Troubleshooting

- `No supported agent CLI found` or `Couldn't start …`: the CLI isn't on PATH for the server. Pass `--agent-cmd /full/path/to/cli`.
- A specific port is needed: add `--port 8765`. The default is a random free port.
- Blank page or "PDF engine didn't load": the reader loads pdf.js, pdf-lib and marked from public CDNs (cdnjs, jsDelivr), so it needs internet access.
- Scanned PDFs have no selectable text. **Explain page** still works through the page image.
