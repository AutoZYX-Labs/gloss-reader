#!/usr/bin/env node
// Margin Reader local server. Serves the reader for one PDF on 127.0.0.1 and answers
// questions through the user's own Claude Code (`claude -p`). No dependencies.
//
//   node server.mjs <file.pdf> [--port 0] [--model sonnet] [--no-open]

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def; };
const has = (name) => args.includes(name);
const pdfArg = args.find((a, i) => !a.startsWith("--") && !["--port", "--model", "--claude"].includes(args[i - 1]));

if (!pdfArg) { console.error("Usage: node server.mjs <file.pdf> [--port N] [--model NAME] [--no-open]"); process.exit(2); }
const PDF = path.resolve(pdfArg);
if (!fs.existsSync(PDF) || !fs.statSync(PDF).isFile()) { console.error(`Not found: ${PDF}`); process.exit(2); }
const PORT = Number(flag("--port", "0"));
const MODEL = flag("--model", process.env.MARGIN_READER_MODEL || "");
const CLAUDE = flag("--claude", process.env.MARGIN_READER_CLAUDE || "claude");
const SIDECAR = PDF + ".margin.json";
const RUN_ID = crypto.createHash("sha1").update(PDF).digest("hex").slice(0, 12);
const LOG = path.join(os.tmpdir(), `margin-reader-${RUN_ID}.log`);
const PIDFILE = path.join(os.tmpdir(), `margin-reader-${RUN_ID}.pid`);
const IDLE_MS = Number(flag("--idle-hours", "4")) * 3600e3;

// --stop: stop a detached reader for this PDF.
if (has("--stop")) {
  try { const pid = Number(fs.readFileSync(PIDFILE, "utf8")); process.kill(pid, "SIGTERM"); fs.rmSync(PIDFILE, { force: true }); console.log(`Stopped Margin Reader for ${path.basename(PDF)}.`); }
  catch { console.log(`No running Margin Reader found for ${path.basename(PDF)}.`); }
  process.exit(0);
}
// --detach: start the server in the background, print its URL, and return.
if (has("--detach")) {
  try { const old = Number(fs.readFileSync(PIDFILE, "utf8")); process.kill(old, "SIGTERM"); } catch {}
  const fd = fs.openSync(LOG, "w");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args.filter((a) => a !== "--detach")], { detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  fs.writeFileSync(PIDFILE, String(child.pid));
  const t0 = Date.now();
  const poll = () => {
    const out = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8") : "";
    if (out.includes("Press Ctrl+C") || out.includes("Error") || Date.now() - t0 > 15000) {
      console.log(out.replace("Press Ctrl+C to stop.", `Running in the background (stops after ${IDLE_MS / 3600e3} h idle). Stop it with: node "${fileURLToPath(import.meta.url)}" "${PDF}" --stop`).trim());
      process.exit(out.includes("URL:") ? 0 : 1);
    }
    setTimeout(poll, 150);
  };
  poll();
}
const TOKEN = crypto.randomBytes(18).toString("base64url");
const NAME = path.basename(PDF);

const page = () => {
  const reader = fs.readFileSync(path.join(HERE, "app", "reader.html"), "utf8");
  const shim = fs.readFileSync(path.join(HERE, "app", "local-shim.js"), "utf8");
  const cfg = JSON.stringify({ token: TOKEN, name: NAME, pdfUrl: "/doc.pdf?t=" + TOKEN }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>:root{color-scheme:light}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
<script>window.MARGIN_LOCAL=${cfg};</script><script>${shim}</script></head><body>
${reader}
</body></html>`;
};

// ---- Claude Code bridge ----
function buildPrompt(turns) {
  // The page sends: [instructions+document context, ...earlier turns, current request].
  const [first, ...rest] = turns;
  const current = rest.length ? rest[rest.length - 1] : null;
  const earlier = rest.slice(0, -1);
  let out = first.content + "\n\n";
  if (earlier.length) {
    out += "Earlier in this reading session:\n";
    for (const t of earlier) out += `\n[${t.role === "assistant" ? "You answered" : "Reader asked"}]\n${t.content}\n`;
    out += "\n";
  }
  if (current) out += "Current request from the reader:\n" + current.content;
  return out;
}

async function ask(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req, 40e6)); } catch { return send(res, 400, "bad json"); }
  const turns = Array.isArray(body.turns) ? body.turns.filter((t) => t && typeof t.content === "string") : [];
  if (!turns.length) return send(res, 400, "no turns");

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "margin-reader-"));
  let prompt = buildPrompt(turns);
  const cliArgs = ["-p", "Follow the reading-companion instructions and answer the reader's request, both given on stdin. Reply with the answer only.",
    "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--strict-mcp-config", "--permission-mode", "dontAsk"];
  if (Array.isArray(body.images) && body.images[0]) {
    const img = path.join(tmp, "page.jpg");
    await fsp.writeFile(img, Buffer.from(body.images[0], "base64"));
    prompt += `\n\nAn image of the page is saved at ${img}. Use the Read tool to look at it before answering.`;
    cliArgs.push("--tools", "Read", "--allowedTools", "Read");
  } else {
    cliArgs.push("--tools", "");
  }
  if (MODEL) cliArgs.push("--model", MODEL);

  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  const emit = (t, v) => { if (!res.writableEnded) res.write(JSON.stringify({ t, v }) + "\n"); };

  let child;
  try {
    child = spawn(CLAUDE, cliArgs, { cwd: tmp, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
  } catch (e) {
    emit("e", "Couldn't start Claude Code: " + e.message); res.end(); return;
  }
  let streamed = false, finalText = "", stderr = "", buf = "";
  child.on("error", (e) => { emit("e", `Couldn't start Claude Code (${CLAUDE}): ${e.message}`); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === "stream_event" && o.event?.delta?.type === "text_delta") {
        // Only stream the final answer's text; text before a tool call is narration.
        streamed = true; emit("d", o.event.delta.text);
      } else if (o.type === "stream_event" && o.event?.type === "content_block_start" && o.event?.content_block?.type === "tool_use" && streamed) {
        emit("d", "\n\n");
      } else if (o.type === "result") {
        if (o.is_error) emit("e", String(o.result || o.subtype || "error"));
        else finalText = String(o.result || "");
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => { stderr += d; if (stderr.length > 4000) stderr = stderr.slice(-4000); });
  child.on("close", (code) => {
    if (!streamed && finalText) emit("d", finalText);
    if (code && !streamed && !finalText) emit("e", (stderr.trim().split("\n").pop() || `Claude Code exited with code ${code}`).slice(0, 400));
    res.end();
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
  // Stop paying for an answer nobody is waiting for.
  res.on("close", () => { if (child.exitCode === null) child.kill("SIGTERM"); });
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
}

// ---- HTTP ----
function send(res, code, text, type = "text/plain; charset=utf-8") { res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(text); }
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(new Error("too large")); req.destroy(); } else parts.push(c); });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}
function freeName(dir, name) {
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  let cand = name, i = 2;
  while (fs.existsSync(path.join(dir, cand))) cand = `${base} ${i++}${ext}`;
  return path.join(dir, cand);
}

let lastActivity = Date.now();
const server = http.createServer(async (req, res) => {
  lastActivity = Date.now();
  try {
    const url = new URL(req.url, "http://localhost");
    const host = (req.headers.host || "").split(":")[0];
    if (host !== "127.0.0.1" && host !== "localhost") return send(res, 403, "forbidden host");
    const authed = req.headers["x-margin-token"] === TOKEN || url.searchParams.get("t") === TOKEN;

    if (req.method === "GET" && url.pathname === "/") {
      if (!authed) return send(res, 403, "Open the link printed by Margin Reader (it includes an access token).");
      return send(res, 200, page(), "text/html; charset=utf-8");
    }
    if (!authed) return send(res, 403, "forbidden");

    if (req.method === "GET" && url.pathname === "/doc.pdf") {
      res.writeHead(200, { "Content-Type": "application/pdf", "Cache-Control": "no-store" });
      return fs.createReadStream(PDF).pipe(res);
    }
    if (url.pathname === "/api/annotations") {
      if (req.method === "GET") {
        const txt = fs.existsSync(SIDECAR) ? await fsp.readFile(SIDECAR, "utf8") : "{}";
        return send(res, 200, txt, "application/json");
      }
      if (req.method === "PUT") {
        const raw = (await readBody(req, 20e6)).toString("utf8");
        const data = JSON.parse(raw);
        if (!data || typeof data !== "object" || Array.isArray(data)) return send(res, 400, "bad data");
        const tmpFile = SIDECAR + ".tmp";
        await fsp.writeFile(tmpFile, JSON.stringify(data, null, 1));
        await fsp.rename(tmpFile, SIDECAR);
        return send(res, 200, "{}", "application/json");
      }
    }
    if (req.method === "POST" && url.pathname === "/api/save") {
      const want = path.basename(url.searchParams.get("name") || "highlighted.pdf").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_");
      const name = want.toLowerCase().endsWith(".pdf") ? want : want + ".pdf";
      const out = freeName(path.dirname(PDF), name);
      await fsp.writeFile(out, await readBody(req, 500e6));
      return send(res, 200, JSON.stringify({ path: out }), "application/json");
    }
    if (req.method === "POST" && url.pathname === "/api/ask") return ask(req, res);
    send(res, 404, "not found");
  } catch (e) {
    if (!res.headersSent) send(res, 500, String(e.message || e)); else res.end();
  }
});

if (!has("--detach")) setInterval(() => { if (Date.now() - lastActivity > IDLE_MS) { console.log("Idle; stopping."); process.exit(0); } }, 60e3).unref();
if (!has("--detach")) server.listen(PORT, "127.0.0.1", () => {
  const { port } = server.address();
  const link = `http://127.0.0.1:${port}/?t=${TOKEN}`;
  console.log(`Margin Reader is open for ${NAME}`);
  console.log(`URL: ${link}`);
  console.log(`Highlights and comments are saved to ${SIDECAR}`);
  console.log("Press Ctrl+C to stop.");
  if (!has("--no-open")) {
    const opener = process.platform === "darwin" ? ["open", [link]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", link]] : ["xdg-open", [link]];
    try { spawn(opener[0], opener[1], { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch {}
  }
});
