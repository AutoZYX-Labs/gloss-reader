#!/usr/bin/env node
// Gloss Reader local server. Serves the reader for one PDF on 127.0.0.1 and answers questions
// through a coding agent's own CLI (Claude Code, Codex or Gemini CLI). No dependencies.
//
//   node server.mjs <file.pdf> --detach [--agent claude|codex|gemini] [--model NAME] [--no-open]
//   node server.mjs <file.pdf> --stop

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);
const args = process.argv.slice(2);
const VALUE_FLAGS = ["--port", "--model", "--agent", "--agent-cmd", "--idle-hours"];
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def; };
const has = (name) => args.includes(name);
const pdfArg = args.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(args[i - 1]));

if (!pdfArg) {
  console.error("Usage: node server.mjs <file.pdf> [--detach|--stop] [--agent claude|codex|gemini] [--model NAME] [--port N] [--no-open]");
  process.exit(2);
}
const PDF = path.resolve(pdfArg);
const NAME = path.basename(PDF);
const RUN_ID = crypto.createHash("sha1").update(PDF).digest("hex").slice(0, 12);
const LOG = path.join(os.tmpdir(), `gloss-reader-${RUN_ID}.log`);
const PIDFILE = path.join(os.tmpdir(), `gloss-reader-${RUN_ID}.pid`);

// ---- --stop ----
if (has("--stop")) {
  try { process.kill(Number(fs.readFileSync(PIDFILE, "utf8")), "SIGTERM"); fs.rmSync(PIDFILE, { force: true }); console.log(`Stopped Gloss Reader for ${NAME}.`); }
  catch { console.log(`No running Gloss Reader found for ${NAME}.`); }
  process.exit(0);
}
if (!fs.existsSync(PDF) || !fs.statSync(PDF).isFile()) { console.error(`Not found: ${PDF}`); process.exit(2); }

// ---- Agents ----
const AGENTS = {
  claude: { label: "Claude", cmd: "claude" },
  codex: { label: "Codex", cmd: "codex" },
  gemini: { label: "Gemini", cmd: "gemini" },
};
const onPath = (cmd) => {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore", shell: process.platform === "win32" });
  return r.status === 0;
};
function pickAgent() {
  const want = String(flag("--agent", process.env.GLOSS_AGENT || "auto")).toLowerCase();
  if (want !== "auto") {
    if (!AGENTS[want]) { console.error(`Unknown agent "${want}". Use claude, codex or gemini.`); process.exit(2); }
    return want;
  }
  for (const k of Object.keys(AGENTS)) if (onPath(AGENTS[k].cmd)) return k;
  console.error("No supported agent CLI found on PATH (claude, codex or gemini). Pass --agent and --agent-cmd /path/to/cli.");
  process.exit(2);
}

// ---- --detach: run the server in the background, print its URL, return ----
if (has("--detach")) {
  try { process.kill(Number(fs.readFileSync(PIDFILE, "utf8")), "SIGTERM"); } catch {}
  const agent = pickAgent(); // fail fast here, where the user can see it
  const fd = fs.openSync(LOG, "w");
  const rest = args.filter((a) => a !== "--detach");
  if (!rest.includes("--agent")) rest.push("--agent", agent);
  const child = spawn(process.execPath, [SELF, ...rest], { detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  fs.writeFileSync(PIDFILE, String(child.pid));
  const t0 = Date.now();
  const poll = () => {
    const out = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8") : "";
    const ready = out.includes("URL:");
    if (ready || /error|not found/i.test(out) || Date.now() - t0 > 15000) {
      console.log(out.trim());
      if (ready) console.log(`Running in the background (stops after ${Number(flag("--idle-hours", "4"))} h idle). Stop it with: node "${SELF}" "${PDF}" --stop`);
      process.exit(ready ? 0 : 1);
    }
    setTimeout(poll, 150);
  };
  poll();
} else {
  startServer();
}

function startServer() {
  const AGENT = pickAgent();
  const AGENT_CMD = flag("--agent-cmd", process.env.GLOSS_AGENT_CMD || AGENTS[AGENT].cmd);
  const MODEL = flag("--model", process.env.GLOSS_MODEL || "");
  const PORT = Number(flag("--port", "0"));
  const IDLE_MS = Number(flag("--idle-hours", "4")) * 3600e3;
  const SIDECAR = PDF + ".gloss.json";
  const TOKEN = crypto.randomBytes(18).toString("base64url");

  const page = () => {
    const reader = fs.readFileSync(path.join(HERE, "app", "reader.html"), "utf8");
    const shim = fs.readFileSync(path.join(HERE, "app", "local-shim.js"), "utf8");
    const cfg = JSON.stringify({ token: TOKEN, name: NAME, pdfUrl: "/doc.pdf?t=" + TOKEN, agentName: AGENTS[AGENT].label }).replace(/</g, "\\u003c");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>:root{color-scheme:light}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
<script>window.GLOSS_LOCAL=${cfg};</script><script>${shim}</script></head><body>
${reader}
</body></html>`;
  };

  // The page sends [instructions + document context, ...earlier turns, current request]; flatten for a one-shot CLI call.
  function buildPrompt(turns) {
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
  const INSTRUCTION = "Follow the reading-companion instructions and answer the reader's request, both given on stdin. Reply with the answer only, without narrating your steps.";

  // Each agent: how to invoke it, and how to turn its stdout lines into answer text.
  function agentRun(prompt, imgPath, tmp) {
    if (AGENT === "claude") {
      const a = ["-p", INSTRUCTION, "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--strict-mcp-config", "--permission-mode", "dontAsk"];
      if (imgPath) { prompt += `\n\nAn image of the page is saved at ${imgPath}. Use the Read tool to look at it before answering.`; a.push("--tools", "Read", "--allowedTools", "Read"); }
      else a.push("--tools", "");
      if (MODEL) a.push("--model", MODEL);
      let streamed = false;
      return {
        args: a, stdin: prompt,
        line(o, emit, fail) {
          if (o.type === "stream_event" && o.event?.delta?.type === "text_delta") { streamed = true; emit(o.event.delta.text); }
          else if (o.type === "stream_event" && o.event?.type === "content_block_start" && o.event?.content_block?.type === "tool_use" && streamed) emit("\n\n");
          else if (o.type === "result") { if (o.is_error) fail(String(o.result || o.subtype || "error")); else if (!streamed && o.result) emit(String(o.result)); }
        },
      };
    }
    if (AGENT === "codex") {
      const last = path.join(tmp, "last.txt");
      const a = ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "--color", "never", "-o", last];
      if (imgPath) { a.push("-i", imgPath); prompt += "\n\nAn image of the page is attached."; }
      if (MODEL) a.push("-m", MODEL);
      a.push("-");
      const seen = new Map(); // item id -> chars already emitted
      let any = false, lastErr = "";
      return {
        args: a, stdin: INSTRUCTION + "\n\n" + prompt,
        line(o, emit, fail) {
          if ((o.type === "item.updated" || o.type === "item.completed") && o.item?.type === "agent_message" && typeof o.item.text === "string") {
            const id = o.item.id || "m", done = seen.get(id) || 0;
            if (!done && any) emit("\n\n");
            if (o.item.text.length > done) { emit(o.item.text.slice(done)); seen.set(id, o.item.text.length); any = true; }
          } else if (o.type === "turn.failed") fail(String(o.error?.message || "Codex turn failed"));
          else if (o.type === "error") lastErr = String(o.message || "");
        },
        close(emit, fail) {
          if (!any && fs.existsSync(last)) { const t = fs.readFileSync(last, "utf8").trim(); if (t) { emit(t); any = true; } }
          if (!any && lastErr) fail(lastErr);
        },
      };
    }
    // gemini
    const a = ["-p", INSTRUCTION, "-o", "stream-json", "--approval-mode", "plan"];
    if (imgPath) prompt += `\n\nThe page image: @${path.basename(imgPath)}`;
    if (MODEL) a.push("-m", MODEL);
    let any = false;
    return {
      args: a, stdin: prompt,
      line(o, emit, fail) {
        if (o.type === "message" && o.role === "assistant" && typeof o.content === "string") { emit(o.content); any = true; }
        else if (o.type === "error") fail(String(o.message || o.error?.message || "Gemini error"));
        else if (o.type === "result" && o.status && o.status !== "success") fail(String(o.error?.message || o.status));
      },
    };
  }

  async function ask(req, res) {
    let body;
    try { body = JSON.parse(await readBody(req, 40e6)); } catch { return send(res, 400, "bad json"); }
    const turns = Array.isArray(body.turns) ? body.turns.filter((t) => t && typeof t.content === "string") : [];
    if (!turns.length) return send(res, 400, "no turns");

    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "gloss-reader-"));
    let imgPath = null;
    if (Array.isArray(body.images) && body.images[0]) {
      imgPath = path.join(tmp, "page.jpg");
      await fsp.writeFile(imgPath, Buffer.from(body.images[0], "base64"));
    }
    const run = agentRun(buildPrompt(turns), imgPath, tmp);

    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    let gotText = false, failed = "";
    const emit = (v) => { if (v && !res.writableEnded) { gotText = true; res.write(JSON.stringify({ t: "d", v }) + "\n"); } };
    const fail = (m) => { failed = failed || m; };

    let child;
    try { child = spawn(AGENT_CMD, run.args, { cwd: tmp, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" }); }
    catch (e) { res.end(JSON.stringify({ t: "e", v: `Couldn't start ${AGENTS[AGENT].label} (${AGENT_CMD}): ${e.message}` }) + "\n"); return; }
    let stderr = "", buf = "";
    child.on("error", (e) => fail(`Couldn't start ${AGENTS[AGENT].label} (${AGENT_CMD}): ${e.message}`));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("{")) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        try { run.line(o, emit, fail); } catch {}
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { stderr += d; if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    child.on("close", (code) => {
      try { run.close?.(emit, fail); } catch {}
      if (!gotText) {
        const why = failed || (code ? (stderr.trim().split("\n").filter(Boolean).pop() || `${AGENTS[AGENT].label} exited with code ${code}`) : "");
        if (why && !res.writableEnded) res.write(JSON.stringify({ t: "e", v: why.slice(0, 400) }) + "\n");
      }
      res.end();
      fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    });
    res.on("close", () => { if (child.exitCode === null) child.kill("SIGTERM"); });
    child.stdin.on("error", () => {});
    child.stdin.end(run.stdin);
  }

  let lastActivity = Date.now();
  const server = http.createServer(async (req, res) => {
    lastActivity = Date.now();
    try {
      const url = new URL(req.url, "http://localhost");
      const host = (req.headers.host || "").split(":")[0];
      if (host !== "127.0.0.1" && host !== "localhost") return send(res, 403, "forbidden host");
      const authed = req.headers["x-gloss-token"] === TOKEN || url.searchParams.get("t") === TOKEN;

      if (req.method === "GET" && url.pathname === "/") {
        if (!authed) return send(res, 403, "Open the link printed by Gloss Reader (it includes an access token).");
        return send(res, 200, page(), "text/html; charset=utf-8");
      }
      if (!authed) return send(res, 403, "forbidden");

      if (req.method === "GET" && url.pathname === "/doc.pdf") {
        res.writeHead(200, { "Content-Type": "application/pdf", "Cache-Control": "no-store" });
        return fs.createReadStream(PDF).pipe(res);
      }
      if (url.pathname === "/api/annotations") {
        if (req.method === "GET") return send(res, 200, fs.existsSync(SIDECAR) ? await fsp.readFile(SIDECAR, "utf8") : "{}", "application/json");
        if (req.method === "PUT") {
          const data = JSON.parse((await readBody(req, 20e6)).toString("utf8"));
          if (!data || typeof data !== "object" || Array.isArray(data)) return send(res, 400, "bad data");
          await fsp.writeFile(SIDECAR + ".tmp", JSON.stringify(data, null, 1));
          await fsp.rename(SIDECAR + ".tmp", SIDECAR);
          return send(res, 200, "{}", "application/json");
        }
      }
      if (req.method === "POST" && url.pathname === "/api/save") {
        const want = path.basename(url.searchParams.get("name") || "highlighted.pdf").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_");
        const out = freeName(path.dirname(PDF), want.toLowerCase().endsWith(".pdf") ? want : want + ".pdf");
        await fsp.writeFile(out, await readBody(req, 500e6));
        return send(res, 200, JSON.stringify({ path: out }), "application/json");
      }
      if (req.method === "POST" && url.pathname === "/api/ask") return ask(req, res);
      send(res, 404, "not found");
    } catch (e) {
      if (!res.headersSent) send(res, 500, String(e.message || e)); else res.end();
    }
  });

  setInterval(() => { if (Date.now() - lastActivity > IDLE_MS) { console.log("Idle; stopping."); process.exit(0); } }, 60e3).unref();
  server.on("error", (e) => { console.error("Error: " + e.message); process.exit(1); });
  server.listen(PORT, "127.0.0.1", () => {
    const link = `http://127.0.0.1:${server.address().port}/?t=${TOKEN}`;
    console.log(`Gloss Reader is open for ${NAME} (answers by ${AGENTS[AGENT].label})`);
    console.log(`URL: ${link}`);
    console.log(`Highlights and comments are saved to ${SIDECAR}`);
    if (!has("--no-open")) {
      const opener = process.platform === "darwin" ? ["open", [link]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", link]] : ["xdg-open", [link]];
      try { spawn(opener[0], opener[1], { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch {}
    }
  });
}

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
