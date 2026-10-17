# Gloss Reader

Read PDFs with an AI beside you. A *gloss* is an explanatory note written in the margin next to a hard passage, and that's what Gloss Reader does: it opens a PDF in your browser with the document on the left and your coding agent on the right.

- **Explain**: select a sentence or paragraph and click **Explain** or **Simpler**. **Explain page N** also sends an image of the page, so figures, tables and equations get explained.
- **Ask**: type follow-up questions about the page or your selection. Switch between *Newcomer* and *Expert* explanations.
- **Highlight**: mark text in yellow, green, blue or pink. Click a highlight to recolour it, explain it or remove it.
- **Comment**: attach notes to passages. The AI takes your comments into account when it explains or summarizes them.
- **Summarize highlights**: your highlighted passages are grouped by theme, with page numbers.
- **Save PDF**: writes `<file> (highlighted).pdf` next to the original, with highlights and comments as standard PDF annotations that Acrobat, Preview and Zotero can read and edit.

Answers come from the agent CLI you already use, so you don't need an extra API key:

| Agent | Command it runs | Status |
|---|---|---|
| Claude Code | `claude -p` | Tested end to end |
| Codex | `codex exec --json` | Tested with a simulated CLI; please report issues |
| Gemini CLI | `gemini -p -o stream-json` | Tested with a simulated CLI; please report issues |

You need Node.js 18 or newer.

## Install

**Claude Code** (plugin):

```text
/plugin marketplace add <github-user>/gloss-reader
/plugin install gloss-reader@gloss-reader
```

Then run `/gloss-reader:gloss thesis.pdf` (or just `/gloss thesis.pdf`), or ask "open thesis.pdf in Gloss Reader".

**Codex** (skill): copy the skill folder into your Codex skills directory:

```bash
git clone https://github.com/<github-user>/gloss-reader
mkdir -p ~/.agents/skills
cp -r gloss-reader/plugins/gloss-reader/skills/gloss ~/.agents/skills/
```

Then type `$gloss thesis.pdf` in Codex, or ask it to open the PDF in Gloss Reader. Codex's sandbox may ask you to approve starting the local server.

**Other agents with Agent Skills support** (Gemini CLI, Cursor and others): use the [skills CLI](https://skills.sh) (`npx skills add <github-user>/gloss-reader`), or copy `plugins/gloss-reader/skills/gloss` into that agent's skills folder.

**Without an agent driving it**, from any terminal:

```bash
node plugins/gloss-reader/skills/gloss/server.mjs thesis.pdf --agent codex
```

## Options

| Option | Meaning |
|---|---|
| `--agent claude\|codex\|gemini` | Which CLI answers questions. By default it uses the first one installed, in that order. |
| `--agent-cmd /path/to/cli` | Use this when the CLI isn't on PATH. |
| `--model NAME` | A model name the chosen CLI accepts. |
| `--detach` / `--stop` | Run in the background and print the link, or stop the background server for that PDF. |
| `--port N`, `--no-open`, `--idle-hours H` | Fixed port, don't open the browser, auto-stop after H idle hours (default 4). |

## Where things are stored

| What | Where |
|---|---|
| Highlights and comments | `thesis.pdf.gloss.json`, next to the PDF. It's plain JSON, so you can keep it with the PDF or commit it. |
| Annotated copy | `thesis (highlighted).pdf`, next to the PDF. Your original is never changed. |

## Privacy

- The server listens only on `127.0.0.1`. Every request needs a random token that is created each time it starts, so other websites and other users on the machine can't use it.
- The PDF never leaves your computer as a file. When you ask something, the reader sends your agent the selected text, the text of the current page, the first two pages (for context), and, for **Explain page**, an image of that page. These go through your agent's CLI under your account, the same as anything else you ask it.
- If you're reading unpublished or confidential work, check your institution's policy on AI tools first.

## How it works

```text
browser (reader.html + local-shim.js)
   │  /api/ask          → server.mjs → claude -p | codex exec | gemini -p  → streamed answer
   │  /api/annotations  → thesis.pdf.gloss.json
   │  /api/save         → thesis (highlighted).pdf
   └  /doc.pdf          ← your PDF
```

`reader.html` is the same page as the hosted claude.ai artifact version. `local-shim.js` gives it the small `window.claude` interface (`sample`, `db`, `downloads`) backed by the local server.

## Limitations

- The reader loads pdf.js, pdf-lib and marked from public CDNs, so it needs internet access (the agent needs it anyway).
- Scanned PDFs have no selectable text. **Explain page** still works because it sends a page image.
- Encrypted PDFs may fail when saving with annotations. You'll see an error instead of a broken file.
- Conversations aren't saved between sessions. Highlights and comments are.

## License

MIT for this project's code. Third-party libraries load at run time under their own licences: [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0), [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT), [marked](https://github.com/markedjs/marked) (MIT).
