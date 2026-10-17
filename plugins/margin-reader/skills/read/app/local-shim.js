// Margin Reader local mode: provides the small `window.claude` surface the reader page uses,
// backed by the local server started by the Claude Code skill. No other pages can call it:
// every API request carries the per-run token the server injected.
(() => {
  const cfg = window.MARGIN_LOCAL || {};
  const H = { "X-Margin-Token": cfg.token || "" };
  const api = (path, init = {}) => fetch(path, { ...init, headers: { ...(init.headers || {}), ...H } });

  // ---- sample: ask Claude through `claude -p` on this machine ----
  async function blobToB64(b) {
    const buf = new Uint8Array(await b.arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }
  async function sample(input, opts = {}) {
    const turns = typeof input === "string" ? [{ role: "user", content: input }] : input;
    let images = [];
    if (opts.images) {
      const list = opts.images instanceof Blob ? [opts.images] : [...opts.images];
      images = await Promise.all(list.slice(0, 1).map(blobToB64));
    }
    let text = "";
    let res;
    try {
      res = await api("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turns, images }),
        signal: opts.signal,
      });
    } catch (e) {
      throw { code: e && e.name === "AbortError" ? "cancelled" : "upstream_error", message: String(e) };
    }
    if (!res.ok || !res.body) throw { code: "upstream_error", message: "HTTP " + res.status };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", errMsg = null;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          if (ev.t === "d" && ev.v) { text += ev.v; opts.onText && opts.onText({ text, delta: ev.v }); }
          else if (ev.t === "e") errMsg = ev.v || "Claude Code reported an error.";
        }
      }
    } catch (e) {
      throw { code: e && e.name === "AbortError" ? "cancelled" : "upstream_error", message: String(e), text: text || undefined };
    }
    if (errMsg && !text) throw { code: "upstream_error", message: errMsg };
    if (!text) throw { code: "empty_completion", message: "No answer" };
    return { text, truncated: false, modelTierApplied: "default" };
  }
  sample.limits = async () => ({ maxPromptBytes: 262144, images: { maxCount: 1, maxInputBytes: 20e6, mediaTypes: ["image/jpeg", "image/png"] } });
  sample.json = async (input, opts) => { const r = await sample(input, opts); return JSON.parse(r.text.slice(r.text.search(/[[{]/))); };

  // ---- db: annotations kept in a sidecar file next to the PDF ----
  let docs = null, saveT = 0;
  const loadDocs = async () => {
    if (docs) return docs;
    try { const r = await api("/api/annotations"); docs = r.ok ? await r.json() : {}; } catch { docs = {}; }
    if (!docs || typeof docs !== "object" || Array.isArray(docs)) docs = {};
    return docs;
  };
  const flush = () => {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      api("/api/annotations", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(docs) }).catch(() => {});
    }, 250);
  };
  const collection = () => ({
    where: (field, _op, value) => ({
      get: async () => {
        const all = await loadDocs();
        const list = Object.entries(all).filter(([, d]) => d && d[field] === value).map(([id, d]) => ({ id, exists: true, data: () => d }));
        return { docs: list, size: list.length, empty: !list.length };
      },
    }),
    doc: (id) => ({
      set: async (d) => { const all = await loadDocs(); all[id] = JSON.parse(JSON.stringify(d)); flush(); },
      delete: async () => { const all = await loadDocs(); delete all[id]; flush(); },
    }),
  });
  const db = { collection };
  const user = { id: async () => "local", isOwner: () => true, canEdit: () => true };

  // ---- downloads: write the file next to the original PDF ----
  const downloads = {
    save: async ({ filename, data }) => {
      const body = data instanceof Blob ? data : new Blob([data]);
      const r = await api("/api/save?name=" + encodeURIComponent(filename), { method: "POST", body });
      if (!r.ok) throw { code: "unavailable", message: "HTTP " + r.status };
      const j = await r.json();
      return { status: "saved", path: j.path };
    },
  };

  const caps = { sample, db, user, downloads };
  window.claude = { use: async (name) => caps[name] || null };
})();
