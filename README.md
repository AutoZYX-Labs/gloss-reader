# Margin Reader

Read PDFs with Claude beside you. Margin Reader is a Claude Code plugin. It opens a PDF in your browser with the document on the left and Claude on the right.

- **Explain**: select a sentence or paragraph and click **Explain** or **Simpler**. **Explain page N** also sends an image of the page, so figures, tables and equations get explained.
- **Ask**: type follow-up questions about the page or your selection. Switch between *Newcomer* and *Expert* explanations.
- **Highlight**: mark text in yellow, green, blue or pink. Click a highlight to recolour it, explain it or remove it.
- **Comment**: attach notes to passages. Claude takes your comments into account when it explains or summarizes them.
- **Summarize highlights**: Claude groups your highlighted passages by theme, with page numbers.
- **Save PDF**: writes `<file> (highlighted).pdf` next to the original, with highlights and comments as standard PDF annotations that Acrobat, Preview and Zotero can read and edit.

Answers come from your own Claude Code (`claude -p`). You don't need an API key, and usage counts against your normal Claude Code plan.

## Install

You need [Claude Code](https://code.claude.com) and Node.js 18 or newer (which Claude Code already requires).

In Claude Code:

```text
/plugin marketplace add <github-user>/margin-reader
/plugin install margin-reader@margin-reader
```

Or from a shell:

```bash
claude plugin marketplace add <github-user>/margin-reader
claude plugin install margin-reader@margin-reader
```

## Use

```text
/margin-reader:read path/to/thesis.pdf
```

You can also just ask: "open thesis.pdf in Margin Reader". Claude starts a local server and opens the reader in your browser. If you don't name a file, it looks for PDFs in the current folder.

Options (pass after the path): `--model sonnet|opus|haiku`, `--port 8765`, `--no-open`.

You can also run it without Claude Code driving it:

```bash
node plugins/margin-reader/skills/read/server.mjs paper.pdf
```

## Where things are stored

| What | Where |
|---|---|
| Highlights and comments | `paper.pdf.margin.json`, next to the PDF. It's plain JSON, so you can keep it with the PDF or commit it. |
| Annotated copy | `paper (highlighted).pdf`, next to the PDF. Your original is never changed. |

## Privacy

- The server listens only on `127.0.0.1`. Every request needs a random token that is created each time it starts, so other websites and other users on the machine can't use it.
- The PDF never leaves your computer as a file. When you ask something, the reader sends Claude the selected text, the text of the current page, the first two pages (for context), and, for **Explain page**, an image of that page. These go through Claude Code under your account, the same as anything else you ask Claude Code.
- If you're reading unpublished or confidential work, check your institution's policy on AI tools first.

## How it works

```text
browser (reader.html + local-shim.js)
   │  /api/ask          → server.mjs → claude -p --output-format stream-json → streamed answer
   │  /api/annotations  → paper.pdf.margin.json
   │  /api/save         → paper (highlighted).pdf
   └  /doc.pdf          ← your PDF
```

`reader.html` is the same page as the hosted claude.ai artifact version. `local-shim.js` gives it the small `window.claude` interface (`sample`, `db`, `downloads`) backed by the local server.

## Limitations

- The reader loads pdf.js, pdf-lib and marked from public CDNs, so it needs internet access (Claude needs it anyway).
- Scanned PDFs have no selectable text. **Explain page** still works because it sends a page image.
- Encrypted PDFs may fail when saving with annotations. You'll see an error instead of a broken file.
- Conversations with Claude aren't saved between sessions. Highlights and comments are.

## License

MIT for this project's code. Third-party libraries load at run time under their own licences: [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0), [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT), [marked](https://github.com/markedjs/marked) (MIT).
