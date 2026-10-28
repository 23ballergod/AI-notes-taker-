/* Pocket Minutes: record in-person meetings on the phone, get notes from Gemini.
   Everything stays on the device (IndexedDB + localStorage) except the audio and text
   sent to the Gemini API with the user's own key. */
(() => {
  "use strict";

  const API = "https://generativelanguage.googleapis.com";
  const SEG_MS = 10 * 60 * 1000;        // new audio file every 10 min of recording
  const SLICE_MS = 5000;                // save to disk every 5 s
  const INLINE_MAX = 14 * 1024 * 1024;  // bigger files go through the Gemini File API
  const FALLBACK_MODEL = "gemini-2.5-flash";
  const APP_VERSION = "4";

  // ---------- small helpers ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "value") el.value = v;
      else if (k === "checked") el.checked = !!v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const wordCount = (s) => (String(s || "").trim().match(/\S+/g) || []).length;

  let toastTimer;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3200);
  }
  const pref = {
    get(k) { try { return localStorage.getItem("pm." + k) || ""; } catch { return ""; } },
    set(k, v) { try { v ? localStorage.setItem("pm." + k, v) : localStorage.removeItem("pm." + k); } catch {} },
  };

  function clock(ms) {
    const s = Math.floor(ms / 1000), hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    const p = (n) => String(n).padStart(2, "0");
    return hh ? hh + ":" + p(mm) + ":" + p(ss) : p(mm) + ":" + p(ss);
  }
  function fmtDate(iso, withTime = true) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const o = { weekday: "short", month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) o.year = "numeric";
    if (withTime) Object.assign(o, { hour: "numeric", minute: "2-digit" });
    return d.toLocaleString([], o);
  }
  const fmtSize = (b) => (b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB");
  const newId = () => "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ---------- storage (IndexedDB) ----------
  const db = (() => {
    let p;
    function open() {
      if (p) return p;
      p = new Promise((res, rej) => {
        const r = indexedDB.open("pocket-minutes", 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          d.createObjectStore("meetings", { keyPath: "id" });
          d.createObjectStore("chunks", { keyPath: ["meetingId", "seg", "idx"] });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return p;
    }
    async function tx(store, mode, fn) {
      const d = await open();
      return new Promise((res, rej) => {
        const t = d.transaction(store, mode);
        const out = fn(t.objectStore(store));
        t.oncomplete = () => res(out && "result" in out ? out.result : out);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error);
      });
    }
    return {
      put: (store, v) => tx(store, "readwrite", (s) => s.put(v)),
      get: (store, k) => tx(store, "readonly", (s) => s.get(k)),
      all: (store) => tx(store, "readonly", (s) => s.getAll()),
      del: (store, k) => tx(store, "readwrite", (s) => s.delete(k)),
      chunks: (id, seg) => tx("chunks", "readonly", (s) => s.getAll(IDBKeyRange.bound([id, seg, 0], [id, seg, Infinity]))),
      dropChunks: (id) => tx("chunks", "readwrite", (s) => s.delete(IDBKeyRange.bound([id, -Infinity, -Infinity], [id, Infinity, Infinity]))),
    };
  })();

  const meetings = new Map();
  async function saveMeeting(m) { m.updatedAt = new Date().toISOString(); meetings.set(m.id, m); await db.put("meetings", m); }

  async function segmentBlob(m, seg) {
    const rows = await db.chunks(m.id, seg.index);
    if (!rows.length) return null;
    return new Blob(rows.map((r) => r.buf), { type: seg.mime || m.mime || "audio/mp4" });
  }

  // ---------- Gemini ----------
  class GemError extends Error { constructor(kind, msg, status) { super(msg); this.kind = kind; this.status = status; } }

  function geminiCopy(e) {
    if (e?.name === "AbortError") return "Stopped.";
    switch (e?.kind) {
      case "nokey": return "Add your Gemini API key in Settings first.";
      case "badkey": return "Gemini didn’t accept your API key. Copy it again from AI Studio and paste it in Settings." + (e.message ? " (Google said: " + e.message.slice(0, 160) + ")" : "");
      case "forbidden": return "Your API key isn’t allowed to use this. Make a new key at aistudio.google.com/apikey and paste it in Settings.";
      case "model": return "The model “" + model() + "” isn’t available to your key. Pick another one in Settings.";
      case "daily": return "You’ve used today’s free Gemini allowance. It resets around midnight Pacific time. Your audio is saved, so tap Try again tomorrow.";
      case "busy": return "Gemini is busy or rate-limiting you. Your audio is saved. Wait a minute, then tap Try again.";
      case "network": return "Couldn’t reach Gemini. Check your internet connection, then tap Try again.";
      case "format": return "Gemini couldn’t read this audio file’s format.";
      case "toolarge": return "This recording is too large to send from the phone. Try a shorter clip.";
      case "blocked": return "Gemini declined to process this audio (" + e.message + ").";
      case "empty": return "Gemini sent back an empty answer. Tap Try again.";
      default: return "Gemini returned an error: " + (e?.message || "unknown").slice(0, 200);
    }
  }

  const apiKey = () => pref.get("key").trim();
  const model = () => pref.get("model") || FALLBACK_MODEL;

  function retryDelayMs(err) {
    const info = (err?.error?.details || []).find((d) => String(d["@type"] || "").includes("RetryInfo"));
    const m = /([\d.]+)s/.exec(info?.retryDelay || "");
    return m ? Math.ceil(parseFloat(m[1]) * 1000) + 500 : 0;
  }

  // POST with retries on rate limits and server errors. Returns the ok Response.
  async function gemFetch(path, body, { signal, onWait, retries = 3 } = {}) {
    const key = apiKey();
    if (!key) throw new GemError("nokey", "no key");
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(API + path, {
          method: "POST", signal,
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(body),
        });
      } catch (e) {
        if (e.name === "AbortError") throw e;
        if (attempt < retries) { await sleep(2000 * (attempt + 1)); continue; }
        throw new GemError("network", e.message);
      }
      if (res.ok) return res;
      const err = await res.json().catch(() => ({}));
      const msg = err?.error?.message || res.statusText || "";
      const st = res.status;
      if (st === 429 && /per ?day|daily|PerDay/i.test(msg + JSON.stringify(err?.error?.details || ""))) throw new GemError("daily", msg, st);
      if ((st === 429 || st >= 500) && attempt < retries) {
        const wait = retryDelayMs(err) || 4000 * 2 ** attempt;
        onWait?.(wait);
        await sleep(wait);
        continue;
      }
      if (st === 429 || st >= 500) throw new GemError("busy", msg, st);
      if (st === 404) throw new GemError("model", msg, st);
      if (st === 401) throw new GemError("badkey", msg, st);
      if (st === 403) throw new GemError("forbidden", msg, st);
      if (st === 400 && /api key/i.test(msg)) throw new GemError("badkey", msg, st);
      if (st === 400 && /mime|format|unsupported|audio|decode/i.test(msg)) throw new GemError("format", msg, st);
      if (st === 413) throw new GemError("toolarge", msg, st);
      throw new GemError("other", msg, st);
    }
  }

  function readText(data) {
    const c = data?.candidates?.[0];
    if (!c) {
      const r = data?.promptFeedback?.blockReason;
      throw r ? new GemError("blocked", r) : new GemError("empty", "no candidates");
    }
    const text = (c.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
    if (!text.trim()) {
      if (c.finishReason && c.finishReason !== "STOP") throw new GemError("blocked", c.finishReason);
      throw new GemError("empty", "empty");
    }
    return text;
  }

  // Thinking costs free-tier tokens and adds nothing to transcription; switch it off where the model allows.
  function genConfig(extra, { noThinking } = {}) {
    const cfg = { temperature: 0.2, ...extra };
    if (noThinking && /2\.5-flash/.test(model())) cfg.thinkingConfig = { thinkingBudget: 0 };
    return cfg;
  }

  async function listModels() {
    const key = apiKey();
    if (!key) throw new GemError("nokey", "no key");
    let res;
    try { res = await fetch(API + "/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": key } }); }
    catch (e) { throw new GemError("network", e.message); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || "";
      if (res.status === 401 || (res.status === 400 && /api key/i.test(msg))) throw new GemError("badkey", msg);
      if (res.status === 403) throw new GemError("forbidden", msg);
      throw new GemError("other", msg);
    }
    return (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => ({ id: m.name.replace(/^models\//, ""), label: m.displayName || m.name }))
      .filter((m) => /gemini/i.test(m.id) && !/embed|image|tts|live|native-audio|vision|aqa|robotics|computer-use/i.test(m.id));
  }

  // Newest stable Flash first; that's the free-tier workhorse and handles audio.
  function pickDefaultModel(list) {
    const ver = (id) => parseFloat((/gemini-(\d+(?:\.\d+)?)/.exec(id) || [])[1] || "0");
    const score = (id) => {
      let s = ver(id) * 100;
      if (/flash/.test(id)) s += 50;
      if (/lite/.test(id)) s -= 30;
      if (/preview|exp/.test(id)) s -= 5;
      if (/pro/.test(id)) s -= 20;
      return s;
    };
    return [...list].sort((a, b) => score(b.id) - score(a.id))[0]?.id || FALLBACK_MODEL;
  }

  function blobToBase64(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1] || "");
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });
  }
  function geminiMime(type) {
    const t = String(type || "").split(";")[0].trim().toLowerCase();
    if (/m4a|x-m4a|aac|mp4/.test(t)) return "audio/mp4";
    if (/mpeg|mp3/.test(t)) return "audio/mp3";
    if (/webm/.test(t)) return "audio/webm";
    if (/ogg|opus/.test(t)) return "audio/ogg";
    if (/wav/.test(t)) return "audio/wav";
    if (/flac/.test(t)) return "audio/flac";
    return t || "audio/mp4";
  }

  // Large files: Gemini File API resumable upload.
  async function uploadFile(blob, mime, { signal } = {}) {
    const key = apiKey();
    let start;
    try {
      start = await fetch(API + "/upload/v1beta/files", {
        method: "POST", signal,
        headers: {
          "x-goog-api-key": key, "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(blob.size), "X-Goog-Upload-Header-Content-Type": mime, "Content-Type": "application/json",
        },
        body: JSON.stringify({ file: { display_name: "meeting-audio" } }),
      });
    } catch (e) { if (e.name === "AbortError") throw e; throw new GemError("toolarge", e.message); }
    const url = start.headers.get("x-goog-upload-url");
    if (!start.ok || !url || !url.startsWith(API + "/")) throw new GemError("toolarge", "upload start failed");
    const up = await fetch(url, {
      method: "POST", signal,
      headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize", "Content-Length": String(blob.size) },
      body: blob,
    });
    const info = await up.json().catch(() => ({}));
    let file = info.file;
    if (!up.ok || !file?.uri) throw new GemError("toolarge", "upload failed");
    for (let i = 0; file.state === "PROCESSING" && i < 60; i++) {
      await sleep(2000);
      const r = await fetch(API + "/v1beta/" + file.name, { headers: { "x-goog-api-key": key }, signal });
      file = await r.json();
    }
    if (file.state === "FAILED") throw new GemError("format", "file processing failed");
    return file.uri;
  }

  // If Gemini can't read the recorder's format, decode on the phone and resend as 16 kHz WAV in 4-minute parts.
  async function toWavParts(blob, partSec = 240) {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    let audio;
    try { audio = await ctx.decodeAudioData(await blob.arrayBuffer()); } finally { ctx.close?.(); }
    const rate = 16000;
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(audio.duration * rate)), rate);
    const src = off.createBufferSource(); src.buffer = audio; src.connect(off.destination); src.start();
    const pcm = (await off.startRendering()).getChannelData(0);
    const parts = [];
    const step = partSec * rate;
    for (let i = 0; i < pcm.length; i += step) parts.push(wav(pcm.subarray(i, Math.min(pcm.length, i + step)), rate));
    return parts;
  }
  function wav(samples, rate) {
    const buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
    const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    return new Blob([buf], { type: "audio/wav" });
  }

  function transcribePrompt(offsetMs) {
    return [
      "This is a recording of an in-person meeting, made on a phone lying on the table.",
      "Write down what was said, word for word, but leave out filler sounds like um and uh.",
      "Start a new paragraph whenever the speaker changes or the topic shifts.",
      "Begin each paragraph with a timestamp in square brackets, like [" + clock(offsetMs) + "]. This audio starts " + clock(offsetMs) + " into the meeting, so count from there.",
      "Write [inaudible] for words you can’t make out. Don’t add a summary, headings or commentary.",
      "If nobody speaks in the audio, reply with exactly: [no speech]",
    ].join("\n");
  }

  async function transcribeOnce(part, offsetMs, opts) {
    const media = part.uri ? { file_data: { mime_type: part.mime, file_uri: part.uri } } : { inline_data: { mime_type: part.mime, data: part.b64 } };
    const res = await gemFetch("/v1beta/models/" + model() + ":generateContent", {
      contents: [{ role: "user", parts: [media, { text: transcribePrompt(offsetMs) }] }],
      generationConfig: genConfig({ maxOutputTokens: 32768 }, { noThinking: true }),
    }, opts);
    const text = readText(await res.json()).trim();
    return /^\[no speech\]$/i.test(text) ? "" : text;
  }

  async function transcribeBlob(blob, offsetMs, opts) {
    const mime = geminiMime(blob.type);
    try {
      if (blob.size <= INLINE_MAX) return await transcribeOnce({ mime, b64: await blobToBase64(blob) }, offsetMs, opts);
      opts.onStage?.("Uploading audio…");
      const uri = await uploadFile(blob, mime, opts);
      return await transcribeOnce({ mime, uri }, offsetMs, opts);
    } catch (e) {
      if (e.kind !== "format") throw e;
    }
    opts.onStage?.("Converting audio…");
    let parts;
    try { parts = await toWavParts(blob); } catch { throw new GemError("format", "could not decode on device"); }
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      const t = await transcribeOnce({ mime: "audio/wav", b64: await blobToBase64(parts[i]) }, offsetMs + i * 240000, opts);
      if (t) out.push(t);
    }
    return out.join("\n\n");
  }

  const NOTES_SCHEMA = {
    type: "OBJECT",
    properties: {
      title: { type: "STRING" },
      summary: { type: "STRING" },
      decisions: { type: "ARRAY", items: { type: "STRING" } },
      actionItems: {
        type: "ARRAY",
        items: { type: "OBJECT", properties: { task: { type: "STRING" }, owner: { type: "STRING" }, due: { type: "STRING" } }, required: ["task", "owner", "due"] },
      },
      openQuestions: { type: "ARRAY", items: { type: "STRING" } },
      topics: { type: "ARRAY", items: { type: "STRING" } },
    },
    required: ["title", "summary", "decisions", "actionItems", "openQuestions", "topics"],
  };

  async function writeNotes(m, opts) {
    const prompt = [
      "You are writing meeting notes from the transcript of an in-person meeting recorded on a phone.",
      "The transcript has no speaker names and may contain speech-recognition mistakes. Infer sensibly, but never invent facts, names, dates or commitments.",
      "Meeting date: " + new Date(m.startedAt).toDateString(),
      "Title given by the user: " + (m.title || "(none, so propose a short, specific title of at most 60 characters)"),
      "People present: " + (m.people || "(not given)"),
      "",
      "Fill in: title; summary (3 to 5 plain sentences on what was covered and concluded); decisions (only what was actually agreed); actionItems (verb-first task, owner only if clear from the transcript else empty string, due as said else empty string); openQuestions (raised but not settled); topics (up to 6 short tags). Use empty arrays when there is nothing.",
      "",
      "Transcript:",
      m.transcript,
    ].join("\n");
    const res = await gemFetch("/v1beta/models/" + model() + ":generateContent", {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: genConfig({ responseMimeType: "application/json", responseSchema: NOTES_SCHEMA, maxOutputTokens: 8192 }),
    }, opts);
    let r;
    try { r = JSON.parse(readText(await res.json())); } catch (e) { if (e instanceof GemError) throw e; throw new GemError("empty", "unreadable JSON"); }
    const arr = (v) => (Array.isArray(v) ? v : []).map((x) => String(x ?? "").trim()).filter(Boolean);
    return {
      title: String(r.title || "").trim().slice(0, 80),
      summary: String(r.summary || "").trim(),
      decisions: arr(r.decisions),
      actionItems: (Array.isArray(r.actionItems) ? r.actionItems : [])
        .map((a) => ({ task: String(a?.task || "").trim(), owner: String(a?.owner || "").trim(), due: String(a?.due || "").trim(), done: false }))
        .filter((a) => a.task),
      openQuestions: arr(r.openQuestions),
      topics: arr(r.topics).slice(0, 6),
      writtenAt: new Date().toISOString(),
      model: model(),
    };
  }

  async function askStream(m, q, onText, signal) {
    const sys = [
      "You answer questions about one in-person meeting, using only its transcript and notes below.",
      "Quote or paraphrase the transcript when it helps, with its [mm:ss] timestamp. If the answer isn’t in the meeting, say so plainly.",
      "Keep answers short and in plain text, no markdown headings.",
      "",
      "Meeting: " + (m.title || "Untitled") + ", " + new Date(m.startedAt).toDateString() + (m.people ? ", with " + m.people : ""),
      m.notes ? "Notes:\n" + toText(m, false) : "",
      "Transcript:\n" + m.transcript,
    ].join("\n");
    const contents = [];
    for (const t of (m.qa || []).slice(-8)) contents.push({ role: "user", parts: [{ text: t.q }] }, { role: "model", parts: [{ text: t.a }] });
    contents.push({ role: "user", parts: [{ text: q }] });
    const res = await gemFetch("/v1beta/models/" + model() + ":streamGenerateContent?alt=sse", {
      systemInstruction: { parts: [{ text: sys }] }, contents, generationConfig: genConfig({ temperature: 0.4 }),
    }, { signal, retries: 1 });
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "", full = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        try {
          const d = JSON.parse(line.slice(5));
          const piece = (d.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
          if (piece) { full += piece; onText(full); }
        } catch {}
      }
    }
    if (!full.trim()) throw new GemError("empty", "empty");
    return full;
  }

  // ---------- processing a meeting ----------
  const jobs = new Map(); // id -> {ctl, stage}

  async function processMeeting(id) {
    if (jobs.has(id)) return;
    const m = meetings.get(id);
    if (!m) return;
    if (!apiKey()) { m.status = "error"; m.error = geminiCopy({ kind: "nokey" }); await saveMeeting(m); render(); return; }
    const ctl = new AbortController();
    const job = { ctl, stage: "" };
    jobs.set(id, job);
    const stage = (s) => { job.stage = s; updateJobUI(id); };
    const opts = { signal: ctl.signal, onWait: (ms) => stage("Gemini asked us to slow down. Waiting " + Math.ceil(ms / 1000) + " s…"), onStage: stage };
    try {
      m.error = null;
      const segs = m.segments.filter((s) => s && s.bytes > 0);
      if (segs.some((s) => s.transcript == null)) {
        m.status = "transcribing"; await saveMeeting(m); render();
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i];
          if (s.transcript != null) continue;
          stage(segs.length > 1 ? "Transcribing part " + (i + 1) + " of " + segs.length + "…" : "Transcribing the audio…");
          const blob = await segmentBlob(m, s);
          if (!blob) { s.transcript = ""; continue; }
          s.transcript = await transcribeBlob(blob, s.startMs || 0, opts);
          await saveMeeting(m);
        }
      }
      m.transcript = segs.map((s) => s.transcript).filter(Boolean).join("\n\n");
      if (wordCount(m.transcript) < 8) {
        m.status = "ready"; m.notes = null; m.error = "Gemini didn’t hear any speech in this recording.";
      } else {
        m.status = "writing"; await saveMeeting(m); stage("Writing the notes…"); render();
        const notes = await writeNotes(m, opts);
        if (!m.title && notes.title) m.title = notes.title;
        m.notes = notes; m.status = "ready";
      }
      await saveMeeting(m);
      if (m.status === "ready" && !m.error) toast("Notes are ready.");
    } catch (e) {
      m.status = e?.name === "AbortError" ? "recorded" : "error";
      m.error = e?.name === "AbortError" ? null : geminiCopy(e);
      await saveMeeting(m);
    } finally {
      jobs.delete(id);
      render();
    }
  }

  // ---------- recorder ----------
  const rec = {
    active: false, meeting: null, stream: null, mr: null, mime: "", seg: -1, idx: 0,
    elapsed: 0, since: 0, paused: false, interrupted: false, pending: new Set(), wake: null,
    ac: null, analyser: null, raf: 0, tick: 0, hiddenAt: 0, notice: "",
  };
  const elapsedNow = () => rec.elapsed + (rec.since ? Date.now() - rec.since : 0);

  function pickMime() {
    if (!window.MediaRecorder) return null;
    for (const t of ["audio/webm;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"]) {
      try { if (MediaRecorder.isTypeSupported(t)) return t; } catch {}
    }
    return "";
  }

  async function getMic() {
    return navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
  }

  async function requestWake() {
    try { rec.wake = await navigator.wakeLock?.request("screen"); } catch { rec.wake = null; }
  }

  function attachStream(stream) {
    rec.stream = stream;
    const track = stream.getAudioTracks()[0];
    if (track) {
      track.onended = () => { if (rec.active && !rec.interrupted) interrupt("The microphone was cut off, maybe by a phone call or another app."); };
      track.onmute = () => { if (rec.active) { rec.notice = "The microphone went quiet. If the screen locked, unlock it to keep recording."; renderRecordingBits(); } };
      track.onunmute = () => { rec.notice = ""; renderRecordingBits(); };
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      rec.ac = rec.ac || new AC();
      rec.ac.resume?.();
      const src = rec.ac.createMediaStreamSource(stream);
      rec.analyser = rec.ac.createAnalyser();
      rec.analyser.fftSize = 512;
      src.connect(rec.analyser);
    } catch { rec.analyser = null; }
  }

  function startSegment() {
    const m = rec.meeting;
    rec.seg += 1; rec.idx = 0;
    const segIndex = rec.seg;
    const opts = rec.mime ? { mimeType: rec.mime, audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 };
    let mr;
    try { mr = new MediaRecorder(rec.stream, opts); } catch { mr = new MediaRecorder(rec.stream); }
    const seg = { index: segIndex, startMs: elapsedNow(), durationMs: 0, bytes: 0, mime: "", transcript: null };
    m.segments[segIndex] = seg;
    mr.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      const i = rec.idx++;
      seg.mime = seg.mime || e.data.type || mr.mimeType || rec.mime;
      const p = e.data.arrayBuffer()
        .then((buf) => db.put("chunks", { meetingId: m.id, seg: segIndex, idx: i, buf }).then(() => buf.byteLength))
        .then((n) => { seg.bytes += n; seg.durationMs = elapsedNow() - seg.startMs; return saveMeeting(m); })
        .catch(() => { rec.notice = "Your phone is out of storage space, so the recording can’t be saved. Stop and free up space."; renderRecordingBits(); });
      rec.pending.add(p); p.finally(() => rec.pending.delete(p));
    };
    mr.start(SLICE_MS);
    seg.mime = mr.mimeType || rec.mime;
    rec.mr = mr;
  }

  function stopSegment() {
    const mr = rec.mr;
    rec.mr = null;
    if (!mr || mr.state === "inactive") return Promise.resolve();
    return new Promise((res) => {
      mr.addEventListener("stop", () => setTimeout(res, 0), { once: true });
      try { mr.stop(); } catch { res(); }
    });
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      toast("This browser can’t record audio. Open Pocket Minutes in Safari on your iPhone.");
      return;
    }
    let stream;
    try { stream = await getMic(); }
    catch (e) {
      toast(e?.name === "NotAllowedError" ? "Microphone access is off. Turn it on in Settings › Safari › Microphone, then try again." : "Couldn’t start the microphone: " + (e?.message || e));
      return;
    }
    const m = {
      id: newId(), kind: "recording", title: "", people: "", startedAt: new Date().toISOString(),
      status: "recording", segments: [], transcript: "", notes: null, qa: [], error: null, durationMs: 0, notices: [],
    };
    Object.assign(rec, { active: true, meeting: m, mime: pickMime() || "", seg: -1, elapsed: 0, since: Date.now(), paused: false, interrupted: false, notice: "" });
    attachStream(stream);
    await saveMeeting(m);
    startSegment();
    await requestWake();
    try { await navigator.storage?.persist?.(); } catch {}
    view = { name: "record" };
    render();
    clearInterval(rec.tick);
    rec.tick = setInterval(onTick, 250);
    drawMeter();
  }

  async function onTick() {
    if (!rec.active) return;
    const c = $("rec-clock"); if (c) c.textContent = clock(elapsedNow());
    const seg = rec.meeting.segments[rec.seg];
    if (!rec.paused && !rec.interrupted && rec.mr && seg && elapsedNow() - seg.startMs >= SEG_MS && !rec.rotating) {
      rec.rotating = true;
      await stopSegment();
      if (rec.active && !rec.paused && !rec.interrupted) startSegment();
      rec.rotating = false;
    }
  }

  function drawMeter() {
    cancelAnimationFrame(rec.raf);
    const bars = [...document.querySelectorAll("#meter span")];
    if (!rec.active) return;
    if (rec.analyser && bars.length) {
      const data = new Uint8Array(rec.analyser.fftSize);
      rec.analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      const level = rec.paused || rec.interrupted ? 0 : Math.min(1, peak / 70);
      rec.levels = [...(rec.levels || []).slice(-(bars.length - 1)), level];
      bars.forEach((b, i) => { b.style.height = Math.max(8, Math.round((rec.levels[i] || 0) * 100)) + "%"; });
    }
    rec.raf = requestAnimationFrame(drawMeter);
  }

  function pauseRecording() {
    if (!rec.mr || rec.paused) return;
    try { rec.mr.pause(); } catch {}
    rec.elapsed = elapsedNow(); rec.since = 0; rec.paused = true;
    renderRecordingBits();
  }
  function resumeRecording() {
    if (!rec.paused) return;
    try { rec.mr?.resume(); } catch {}
    rec.since = Date.now(); rec.paused = false;
    renderRecordingBits();
  }

  async function interrupt(msg) {
    rec.interrupted = true;
    rec.elapsed = elapsedNow(); rec.since = 0;
    rec.meeting.notices.push("Recording stopped at " + clock(rec.elapsed) + ": " + msg);
    await stopSegment();
    rec.stream?.getTracks().forEach((t) => t.stop());
    rec.stream = null;
    rec.notice = msg + " Tap Resume to keep recording.";
    await saveMeeting(rec.meeting);
    renderRecordingBits();
  }
  async function resumeAfterInterrupt() {
    try { attachStream(await getMic()); }
    catch { toast("Couldn’t get the microphone back. Close other apps using it and try again."); return; }
    rec.interrupted = false; rec.paused = false; rec.since = Date.now(); rec.notice = "";
    startSegment();
    await requestWake();
    renderRecordingBits();
  }

  async function stopRecording() {
    if (!rec.active) return;
    const m = rec.meeting;
    const title = $("rec-title")?.value.trim();
    if (title) m.title = title;
    rec.elapsed = elapsedNow(); rec.since = 0;
    clearInterval(rec.tick); cancelAnimationFrame(rec.raf);
    await stopSegment();
    await Promise.allSettled([...rec.pending]);
    rec.stream?.getTracks().forEach((t) => t.stop());
    try { await rec.wake?.release(); } catch {}
    try { await rec.ac?.close(); } catch {}
    Object.assign(rec, { active: false, stream: null, wake: null, ac: null, analyser: null });
    m.durationMs = rec.elapsed;
    m.segments = m.segments.filter(Boolean);
    m.status = "recorded";
    await saveMeeting(m);
    openMeeting(m.id);
    if (apiKey()) processMeeting(m.id);
  }

  document.addEventListener("visibilitychange", async () => {
    if (!rec.active) return;
    if (document.hidden) { rec.hiddenAt = Date.now(); return; }
    await requestWake();
    const away = rec.hiddenAt ? Date.now() - rec.hiddenAt : 0;
    rec.hiddenAt = 0;
    if (away > 3000 && !rec.paused) {
      const note = "The app was in the background for " + clock(away) + ". Audio from that stretch may be missing.";
      rec.meeting.notices.push(note);
      rec.notice = note;
      saveMeeting(rec.meeting);
      renderRecordingBits();
    }
  });
  window.addEventListener("beforeunload", (e) => { if (rec.active) { e.preventDefault(); e.returnValue = ""; } });

  // ---------- import ----------
  async function importAudio(file) {
    if (!file) return;
    const m = {
      id: newId(), kind: "import", title: file.name.replace(/\.[^.]+$/, ""), people: "",
      startedAt: new Date(file.lastModified || Date.now()).toISOString(), status: "recorded",
      segments: [{ index: 0, startMs: 0, durationMs: 0, bytes: file.size, mime: file.type || "audio/mp4", transcript: null }],
      transcript: "", notes: null, qa: [], error: null, durationMs: 0, notices: [],
    };
    try {
      await db.put("chunks", { meetingId: m.id, seg: 0, idx: 0, buf: await file.arrayBuffer() });
    } catch { toast("Couldn’t save that file. Your phone may be out of storage."); return; }
    m.durationMs = m.segments[0].durationMs = await audioDuration(file);
    await saveMeeting(m);
    openMeeting(m.id);
    if (apiKey()) processMeeting(m.id);
  }
  function audioDuration(blob) {
    return new Promise((res) => {
      const a = document.createElement("audio");
      const url = URL.createObjectURL(blob);
      const done = (v) => { URL.revokeObjectURL(url); res(v); };
      a.preload = "metadata";
      a.onloadedmetadata = () => done(isFinite(a.duration) ? Math.round(a.duration * 1000) : 0);
      a.onerror = () => done(0);
      setTimeout(() => done(0), 5000);
      a.src = url;
    });
  }

  // ---------- export ----------
  function toText(m, withTranscript) {
    const n = m.notes || {};
    const out = [m.title || "Untitled meeting", fmtDate(m.startedAt) + (m.durationMs ? " · " + clock(m.durationMs) : "") + (m.people ? " · with " + m.people : ""), ""];
    if (n.summary) out.push("SUMMARY", n.summary, "");
    if (n.actionItems?.length) { out.push("ACTION ITEMS"); for (const a of n.actionItems) out.push((a.done ? "[x] " : "[ ] ") + a.task + (a.owner ? " — " + a.owner : "") + (a.due ? " (due " + a.due + ")" : "")); out.push(""); }
    if (n.decisions?.length) { out.push("DECISIONS"); for (const d of n.decisions) out.push("- " + d); out.push(""); }
    if (n.openQuestions?.length) { out.push("STILL OPEN"); for (const q of n.openQuestions) out.push("- " + q); out.push(""); }
    if (withTranscript && m.transcript) out.push("TRANSCRIPT", m.transcript);
    return out.join("\n").trim();
  }
  function toMarkdown(m) {
    const n = m.notes || {};
    const out = ["# " + (m.title || "Untitled meeting"), "", fmtDate(m.startedAt) + (m.people ? " · with " + m.people : ""), ""];
    if (n.summary) out.push("## Summary", "", n.summary, "");
    if (n.actionItems?.length) { out.push("## Action items", ""); for (const a of n.actionItems) out.push("- [" + (a.done ? "x" : " ") + "] " + a.task + (a.owner ? " — " + a.owner : "") + (a.due ? " (due " + a.due + ")" : "")); out.push(""); }
    if (n.decisions?.length) { out.push("## Decisions", ""); for (const d of n.decisions) out.push("- " + d); out.push(""); }
    if (n.openQuestions?.length) { out.push("## Still open", ""); for (const q of n.openQuestions) out.push("- " + q); out.push(""); }
    if (m.transcript) out.push("## Transcript", "", m.transcript, "");
    return out.join("\n");
  }

  // ---------- views ----------
  let view = { name: "home" };
  const ui = { tab: "notes", askDraft: "", asking: null };

  function openMeeting(id) { view = { name: "meeting", id }; ui.tab = "notes"; ui.askDraft = ""; render(); window.scrollTo(0, 0); }
  function goHome() { if (rec.active) { view = { name: "record" }; render(); return; } view = { name: "home" }; render(); window.scrollTo(0, 0); }
  function goSettings() { if (rec.active) { toast("Stop the recording before opening Settings."); return; } view = { name: "settings" }; render(); window.scrollTo(0, 0); }

  function render() {
    const root = $("view");
    if (ui.asking && view.name === "meeting") return; // don't wipe a streaming answer
    let node;
    if (view.name === "record" && rec.active) node = renderRecording();
    else if (view.name === "meeting" && meetings.has(view.id)) node = renderMeeting(meetings.get(view.id));
    else if (view.name === "settings") node = renderSettings();
    else { view = { name: "home" }; node = renderHome(); }
    root.replaceChildren(node);
    if (view.name === "record") { renderRecordingBits(); drawMeter(); }
  }

  function statusChip(m) {
    if (jobs.has(m.id) || m.status === "transcribing" || m.status === "writing") return h("span", { class: "chip accent" }, "Working");
    if (m.status === "recording") return h("span", { class: "chip warn" }, rec.active && rec.meeting?.id === m.id ? "Recording" : "Unfinished");
    if (m.status === "error") return h("span", { class: "chip err" }, "Needs attention");
    if (m.notes) return h("span", { class: "chip ok" }, "Notes ready");
    return h("span", { class: "chip" }, "Not processed");
  }

  function isIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); }
  function isStandalone() { return navigator.standalone === true || matchMedia("(display-mode: standalone)").matches; }

  function renderHome() {
    const list = [...meetings.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    const file = h("input", { type: "file", accept: "audio/*,.m4a,.mp3,.wav,.aac,.ogg,.webm", "aria-label": "Import a recording" });
    file.addEventListener("change", () => { importAudio(file.files?.[0]); file.value = ""; });

    return h("div", { class: "wrap", style: "padding:0" },
      isIOS() && !isStandalone() ? h("div", { class: "banner" },
        h("strong", {}, "Install it like an app"),
        h("p", {}, "In Safari, tap the Share button, then Add to Home Screen. Opened from the home screen, Pocket Minutes runs full screen and keeps your meetings safe from Safari’s cleanup."),
      ) : null,
      !apiKey() ? h("div", { class: "banner warn" },
        h("strong", {}, "Add your Gemini API key"),
        h("p", {}, "You can record without one, but the notes are written by Gemini."),
        h("div", { class: "row" }, h("button", { class: "primary", type: "button", onclick: goSettings }, "Open Settings")),
      ) : null,
      h("section", { class: "card glass rec-hero" },
        h("p", { class: "eyebrow" }, "Phone on the table"),
        h("h1", {}, "Record a meeting"),
        h("button", { class: "rec-btn", type: "button", onclick: startRecording }, "Record"),
        h("p", { class: "caption" }, "The screen stays on while recording. Every 5 seconds is saved, so nothing is lost if the app closes."),
        h("label", { class: "file-btn" }, "Import a recording", file),
      ),
      h("section", { class: "section" },
        h("div", { class: "row", style: "justify-content:space-between" }, h("h2", {}, "Meetings"), list.length ? h("span", { class: "caption" }, list.length + (list.length === 1 ? " meeting" : " meetings")) : null),
        list.length
          ? h("ul", { class: "list" }, list.map((m) => h("li", {},
              h("button", { class: "m-item", type: "button", onclick: () => (m.status === "recording" && rec.active && rec.meeting?.id === m.id ? goHome() : openMeeting(m.id)) },
                h("span", { class: "t" }, m.title || "Untitled meeting"),
                h("span", { class: "meta" },
                  h("span", { class: "caption" }, fmtDate(m.startedAt) + (m.durationMs ? " · " + clock(m.durationMs) : "")),
                  statusChip(m),
                  m.notes?.actionItems?.filter((a) => !a.done).length ? h("span", { class: "caption" }, m.notes.actionItems.filter((a) => !a.done).length + " to do") : null,
                ),
              ),
            )))
          : h("p", { class: "empty" }, "No meetings yet. Tap Record when your next meeting starts."),
      ),
    );
  }

  function renderRecording() {
    const bars = Array.from({ length: 28 }, () => h("span"));
    const title = h("input", { id: "rec-title", type: "text", placeholder: "Name this meeting (optional)", value: rec.meeting.title || "" });
    title.addEventListener("change", () => { rec.meeting.title = title.value.trim(); saveMeeting(rec.meeting); });
    return h("div", { class: "recording" },
      h("span", { id: "rec-live", class: "live" }, h("span", { class: "dot" }), h("span", { id: "rec-state" }, "Recording")),
      h("div", { id: "rec-clock", class: "clock" }, clock(elapsedNow())),
      h("div", { id: "meter", class: "meter", "aria-hidden": "true" }, bars),
      title,
      h("div", { id: "rec-notice", class: "banner warn", hidden: !rec.notice }, rec.notice),
      h("div", { class: "row", style: "justify-content:center" },
        h("button", { id: "rec-pause", type: "button", onclick: () => (rec.interrupted ? resumeAfterInterrupt() : rec.paused ? resumeRecording() : pauseRecording()) }, "Pause"),
        h("button", { class: "primary", type: "button", onclick: stopRecording }, "Stop and write notes"),
      ),
      h("p", { class: "caption" }, "Keep the phone face-up with the screen on. iPhone stops web apps from recording when the screen locks."),
    );
  }
  function renderRecordingBits() {
    const live = $("rec-live"); if (!live) return;
    const stopped = rec.paused || rec.interrupted;
    live.classList.toggle("paused", stopped);
    $("rec-state").textContent = rec.interrupted ? "Stopped" : rec.paused ? "Paused" : "Recording";
    $("rec-pause").textContent = stopped ? "Resume" : "Pause";
    const n = $("rec-notice"); n.textContent = rec.notice; n.hidden = !rec.notice;
  }

  function updateJobUI(id) {
    const el = $("job-stage");
    if (el && view.name === "meeting" && view.id === id) el.textContent = jobs.get(id)?.stage || "";
  }

  function renderMeeting(m) {
    const tabBtn = (key, label) => h("button", {
      class: "tab", type: "button", role: "tab", "aria-selected": ui.tab === key ? "true" : "false",
      onclick: () => { ui.tab = key; render(); },
    }, label);
    const title = h("input", { class: "title-input", type: "text", value: m.title || "", placeholder: "Untitled meeting", "aria-label": "Meeting title" });
    title.addEventListener("change", () => { m.title = title.value.trim(); saveMeeting(m); });

    let body;
    if (ui.tab === "transcript") body = m.transcript ? h("div", { class: "card solid transcript" }, m.transcript) : h("p", { class: "empty" }, "No transcript yet.");
    else if (ui.tab === "ask") body = renderAsk(m);
    else if (ui.tab === "audio") body = renderAudio(m);
    else body = renderNotes(m);

    return h("div", { class: "wrap", style: "padding:0" },
      h("div", { class: "section", style: "gap:4px" },
        h("button", { class: "ghost", type: "button", style: "justify-self:start;padding:0", onclick: goHome }, "‹ All meetings"),
        title,
        h("p", { class: "caption" }, [fmtDate(m.startedAt), m.durationMs ? clock(m.durationMs) : "", m.transcript ? wordCount(m.transcript).toLocaleString() + " words" : ""].filter(Boolean).join(" · ")),
      ),
      h("div", { class: "tabs", role: "tablist" }, tabBtn("notes", "Notes"), tabBtn("ask", "Ask"), tabBtn("transcript", "Transcript"), tabBtn("audio", "Audio")),
      body,
    );
  }

  function renderNotes(m) {
    const job = jobs.get(m.id);
    if (job) {
      return h("div", { class: "card glass" },
        h("div", { class: "working" }, h("span", { class: "pulse" }), h("span", { id: "job-stage" }, job.stage || "Working…")),
        h("p", { class: "caption" }, "Gemini takes about a minute for every 10 minutes of audio. You can leave this screen; it keeps going while the app is open."),
        h("div", { class: "row" }, h("button", { type: "button", onclick: () => job.ctl.abort() }, "Stop")),
      );
    }
    const notices = (m.notices || []).length ? h("div", { class: "banner warn" }, (m.notices || []).map((t) => h("p", {}, t))) : null;
    if (!m.notes) {
      const unfinished = m.status === "recording";
      return h("div", { class: "section" },
        notices,
        m.error ? h("div", { class: "banner err" }, h("p", {}, m.error)) : null,
        unfinished ? h("div", { class: "banner" }, h("p", {}, "The app closed while this meeting was recording. The audio saved up to that point is safe.")) : null,
        h("div", { class: "card glass" },
          h("p", {}, m.error ? "Your audio is saved on this phone." : "This meeting hasn’t been turned into notes yet."),
          h("div", { class: "row" },
            h("button", { class: "primary", type: "button", onclick: () => (apiKey() ? recoverAndProcess(m) : goSettings()) }, apiKey() ? (m.error ? "Try again" : "Write the notes") : "Add API key"),
          ),
        ),
        h("div", { class: "row" }, deleteButton(m)),
      );
    }
    const n = m.notes;
    const items = n.actionItems || [];
    const open = items.filter((a) => !a.done).length;
    const todo = h("ul", { class: "todo" }, items.map((a, i) => h("li", { class: a.done ? "done" : "" },
      h("input", {
        type: "checkbox", checked: a.done, "aria-label": "Done: " + a.task,
        onchange: (ev) => { a.done = ev.target.checked; saveMeeting(m); ev.target.closest("li").classList.toggle("done", a.done); },
      }),
      h("div", {}, h("div", { class: "task" }, a.task), (a.owner || a.due) ? h("div", { class: "caption" }, [a.owner, a.due ? "due " + a.due : ""].filter(Boolean).join(" · ")) : null),
    )));
    const list = (arr) => h("ul", { class: "bullets" }, arr.map((x) => h("li", {}, x)));

    return h("div", { class: "section", style: "gap:var(--space-6)" },
      notices,
      m.error ? h("div", { class: "banner err" }, h("p", {}, m.error)) : null,
      h("div", { class: "card solid" }, h("h3", {}, "Summary"), h("p", { class: "summary" }, n.summary || "No summary.")),
      h("div", { class: "card solid" },
        h("h3", {}, "Action items" + (items.length ? " · " + open + " of " + items.length + " open" : "")),
        items.length ? todo : h("p", { class: "empty" }, "No action items came out of this meeting."),
      ),
      n.decisions?.length ? h("div", { class: "card solid" }, h("h3", {}, "Decisions"), list(n.decisions)) : null,
      n.openQuestions?.length ? h("div", { class: "card solid" }, h("h3", {}, "Still open"), list(n.openQuestions)) : null,
      n.topics?.length ? h("div", { class: "chips" }, n.topics.map((t) => h("span", { class: "chip" }, t))) : null,
      renderShare(m),
      h("div", { class: "row" },
        h("button", { class: "ghost", type: "button", onclick: () => rewrite(m) }, "Rewrite the notes"),
        deleteButton(m),
      ),
      h("p", { class: "caption" }, "Written by " + (n.model || "Gemini") + " on " + fmtDate(n.writtenAt) + "."),
    );
  }

  async function recoverAndProcess(m) {
    if (m.status === "recording") { m.status = "recorded"; m.segments = (m.segments || []).filter(Boolean); }
    m.error = null;
    await saveMeeting(m);
    processMeeting(m.id);
    render();
  }
  async function rewrite(m) {
    if (!m.transcript) return recoverAndProcess(m);
    m.notes = null; await saveMeeting(m);
    processMeeting(m.id); render();
  }

  function deleteButton(m) {
    let armed = false, timer;
    const btn = h("button", { class: "ghost danger", type: "button" }, "Delete meeting");
    btn.addEventListener("click", async () => {
      if (!armed) { armed = true; btn.textContent = "Tap again to delete"; timer = setTimeout(() => { armed = false; btn.textContent = "Delete meeting"; }, 4000); return; }
      clearTimeout(timer);
      jobs.get(m.id)?.ctl.abort();
      await db.dropChunks(m.id); await db.del("meetings", m.id); meetings.delete(m.id);
      toast("Meeting deleted."); goHome();
    });
    return btn;
  }

  function renderShare(m) {
    const status = h("p", { class: "status" });
    const shareBtn = navigator.share ? h("button", { class: "primary", type: "button" }, "Share") : null;
    shareBtn?.addEventListener("click", async () => {
      try { await navigator.share({ title: m.title || "Meeting notes", text: toText(m, false) }); }
      catch (e) { if (e?.name !== "AbortError") status.textContent = "Sharing didn’t work. Use Copy instead."; }
    });
    const copyBtn = h("button", { type: "button" }, "Copy");
    copyBtn.addEventListener("click", () => {
      navigator.clipboard?.writeText(toText(m, false)).then(() => toast("Notes copied."), () => (status.textContent = "Copy was blocked. Select the text and copy it."));
    });
    const email = pref.get("email");
    const mailHref = "mailto:" + encodeURIComponent(email) + "?subject=" + encodeURIComponent("Meeting notes: " + (m.title || "Untitled") + " (" + fmtDate(m.startedAt, false) + ")") + "&body=" + encodeURIComponent(toText(m, false));
    const mail = h("a", { class: "file-btn", href: mailHref, style: "text-decoration:none" }, email ? "Email me" : "Email");
    const dl = h("button", { type: "button", class: "ghost" }, "Save as file");
    dl.addEventListener("click", () => {
      const url = URL.createObjectURL(new Blob([toMarkdown(m)], { type: "text/markdown" }));
      const a = h("a", { href: url, download: (fmtDate(m.startedAt, false) + " " + (m.title || "meeting")).replace(/[\\/:*?"<>|]+/g, "-") + ".md" });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    });
    return h("div", { class: "card glass" },
      h("h3", {}, "Send it somewhere"),
      h("div", { class: "row" }, shareBtn, mail, copyBtn, dl),
      shareBtn ? h("p", { class: "caption" }, "Share opens the iPhone share sheet, so you can send the notes to Gmail, Messages, Notes or Google Docs.") : null,
      status,
    );
  }

  function renderAsk(m) {
    if (!m.transcript) return h("p", { class: "empty" }, "Questions work once the meeting has a transcript.");
    const chat = h("div", { class: "chat" });
    for (const t of m.qa || []) chat.append(h("div", { class: "bubble q" }, t.q), h("div", { class: "bubble a" }, t.a));
    const input = h("textarea", { rows: "2", placeholder: "Ask about this meeting", value: ui.askDraft, "aria-label": "Your question" });
    input.addEventListener("input", () => (ui.askDraft = input.value));
    const send = h("button", { class: "primary", type: "button" }, "Ask");
    const status = h("p", { class: "status" });

    async function ask(text) {
      const q = (text ?? input.value).trim();
      if (!q || ui.asking) return;
      if (!apiKey()) { status.className = "status err"; status.textContent = geminiCopy({ kind: "nokey" }); return; }
      const ctl = new AbortController(); ui.asking = ctl;
      input.value = ""; ui.askDraft = ""; send.disabled = true; status.className = "status"; status.textContent = "";
      const a = h("div", { class: "bubble a" }, h("span", { class: "working" }, h("span", { class: "pulse" }), "Thinking…"));
      chat.append(h("div", { class: "bubble q" }, q), a);
      const stop = h("button", { type: "button", onclick: () => ctl.abort() }, "Stop");
      status.replaceChildren(stop);
      try {
        const answer = await askStream(m, q, (t) => (a.textContent = t), ctl.signal);
        m.qa = [...(m.qa || []), { q, a: answer, at: new Date().toISOString() }].slice(-30);
        await saveMeeting(m);
        status.replaceChildren();
      } catch (e) {
        if (e?.name === "AbortError") { if (!a.textContent || a.querySelector(".working")) a.textContent = "Stopped."; status.replaceChildren(); }
        else { a.remove(); status.className = "status err"; status.textContent = geminiCopy(e); }
      } finally { ui.asking = null; send.disabled = false; }
    }
    send.addEventListener("click", () => ask());
    const ideas = ["What did we decide?", "What do I need to do?", "Summarize this for someone who missed it", "What was left unresolved?"];
    return h("div", { class: "section" },
      (m.qa || []).length ? null : h("p", { class: "empty" }, "Ask anything about this meeting. Gemini answers from the transcript."),
      chat,
      (m.qa || []).length ? null : h("div", { class: "suggest" }, ideas.map((t) => h("button", { type: "button", onclick: () => ask(t) }, t))),
      h("div", { class: "ask-row" }, input, send),
      status,
    );
  }

  function renderAudio(m) {
    const segs = (m.segments || []).filter((s) => s && s.bytes > 0);
    if (!segs.length) return h("p", { class: "empty" }, m.audioDeleted ? "The audio was deleted to free up space. The transcript and notes are kept." : "No audio saved for this meeting.");
    const total = segs.reduce((n, s) => n + s.bytes, 0);
    const box = h("div", { class: "parts" });
    segs.forEach((s, i) => {
      const btn = h("button", { type: "button" }, segs.length > 1 ? "Play part " + (i + 1) + " (from " + clock(s.startMs || 0) + ")" : "Play recording");
      btn.addEventListener("click", async () => {
        const blob = await segmentBlob(m, s);
        if (!blob) return;
        const audio = h("audio", { controls: true, src: URL.createObjectURL(blob) });
        btn.replaceWith(audio); audio.play().catch(() => {});
      });
      box.append(btn);
    });
    const del = h("button", { class: "ghost danger", type: "button" }, "Delete the audio, keep the notes");
    let armed = false;
    del.addEventListener("click", async () => {
      if (!m.transcript) { toast("Write the notes first, so the transcript is saved."); return; }
      if (!armed) { armed = true; del.textContent = "Tap again to delete the audio"; return; }
      await db.dropChunks(m.id);
      m.segments = m.segments.map((s) => ({ ...s, bytes: 0 })); m.audioDeleted = true;
      await saveMeeting(m); toast("Audio deleted."); render();
    });
    return h("div", { class: "section" }, h("p", { class: "caption" }, segs.length + (segs.length === 1 ? " file · " : " files · ") + fmtSize(total)), box, h("div", { class: "row" }, del));
  }

  function renderSettings() {
    const key = h("input", { id: "set-key", type: "password", value: pref.get("key"), placeholder: "Paste your key", autocomplete: "off", autocapitalize: "off", spellcheck: "false" });
    const show = h("button", { type: "button", class: "ghost" }, "Show");
    show.addEventListener("click", () => { key.type = key.type === "password" ? "text" : "password"; show.textContent = key.type === "password" ? "Show" : "Hide"; });
    const keyStatus = h("p", { class: "status" });
    const select = h("select", { id: "set-model" });
    const fillModels = (list) => {
      const cur = model();
      select.replaceChildren(...list.map((x) => h("option", { value: x.id }, x.label + " (" + x.id + ")")));
      if (!list.some((x) => x.id === cur)) select.append(h("option", { value: cur }, cur));
      select.value = cur;
    };
    fillModels([]);
    select.addEventListener("change", () => { pref.set("model", select.value); keyStatus.className = "status"; keyStatus.textContent = "Using " + select.value + "."; });

    const check = h("button", { class: "primary", type: "button" }, "Save and check key");
    check.addEventListener("click", async () => {
      // Pasted keys sometimes pick up spaces or line breaks; keys never contain them.
      const k = key.value.replace(/\s+/g, "");
      key.value = k;
      if (!k) { keyStatus.className = "status err"; keyStatus.textContent = "Paste a key first."; return; }
      // Google issues more than one key format (AIza…, AQ.…), so only reject what can't be a key.
      if (k.length < 20 || k.length > 512 || /[^\x21-\x7e]/.test(k)) { keyStatus.className = "status err"; keyStatus.textContent = "That doesn’t look like a Gemini API key. Copy it again from aistudio.google.com/apikey."; return; }
      pref.set("key", k);
      check.disabled = true; keyStatus.className = "status"; keyStatus.textContent = "Checking with Gemini…";
      try {
        const list = await listModels();
        const prev = pref.get("model");
        if (!prev || !list.some((x) => x.id === prev)) pref.set("model", pickDefaultModel(list));
        fillModels(list);
        keyStatus.textContent = "Key works. " + list.length + " models available. Using " + model() + ".";
      } catch (e) { keyStatus.className = "status err"; keyStatus.textContent = geminiCopy(e); }
      finally { check.disabled = false; }
    });
    if (apiKey()) listModels().then(fillModels).catch(() => {});

    let forgetArmed = false;
    const forget = h("button", { class: "ghost danger", type: "button" }, "Remove key from this phone");
    forget.addEventListener("click", () => {
      if (!forgetArmed) { forgetArmed = true; forget.textContent = "Tap again to remove the key"; return; }
      pref.set("key", ""); pref.set("model", ""); toast("Key removed from this phone."); render();
    });

    const email = h("input", { id: "set-email", type: "email", value: pref.get("email"), placeholder: "you@gmail.com", autocomplete: "email" });
    email.addEventListener("change", () => { pref.set("email", email.value.trim()); toast("Saved."); });

    const usage = h("p", { class: "caption" });
    navigator.storage?.estimate?.().then((e) => { usage.textContent = "Using " + fmtSize(e.usage || 0) + " of storage on this phone."; }).catch(() => {});

    return h("div", { class: "wrap", style: "padding:0" },
      h("div", { class: "section", style: "gap:4px" },
        h("button", { class: "ghost", type: "button", style: "justify-self:start;padding:0", onclick: goHome }, "‹ Back"),
        h("h1", {}, "Settings"),
      ),
      h("div", { class: "card solid" },
        h("h3", {}, "Gemini"),
        h("label", { for: "set-key" }, h("span", {}, "API key ", h("span", { class: "hint" }, "(stays on this phone)")), h("div", { class: "ask-row" }, key, show)),
        h("div", { class: "row" }, check, apiKey() ? forget : null),
        keyStatus,
        h("label", { for: "set-model" }, h("span", {}, "Model ", h("span", { class: "hint" }, "(the newest Flash model is picked for you)")), select),
        h("p", { class: "caption" }, "Get a free key at ", h("a", { href: "https://aistudio.google.com/apikey", target: "_blank", rel: "noopener" }, "aistudio.google.com/apikey"), ". On the free tier Google may use what you send to improve its products, so let people in the room know you’re recording."),
        h("p", { class: "caption" }, "Your key is saved only in this app on this phone and is sent only to Google. It is never part of the app’s code or the website."),
      ),
      h("div", { class: "card solid" },
        h("h3", {}, "Sending notes"),
        h("label", { for: "set-email" }, h("span", {}, "Your email ", h("span", { class: "hint" }, "(fills in “Email me”)")), email),
      ),
      h("div", { class: "card solid" },
        h("h3", {}, "This phone"),
        usage,
        h("p", { class: "caption" }, "Meetings, audio and your key are stored only in this app on this phone. Deleting the app from your home screen deletes them."),
        h("p", { class: "caption" }, "App version " + APP_VERSION + "."),
      ),
    );
  }

  // ---------- boot ----------
  $("go-home").addEventListener("click", goHome);
  $("go-settings").addEventListener("click", goSettings);

  (async () => {
    try {
      for (const m of await db.all("meetings")) {
        // Anything that was mid-flight when the app closed can be resumed by hand.
        if (m.status === "transcribing" || m.status === "writing") m.status = "recorded";
        if (m.status === "recording" && m.segments) m.durationMs = Math.max(0, ...m.segments.filter(Boolean).map((s) => (s.startMs || 0) + (s.durationMs || 0)));
        meetings.set(m.id, m);
      }
    } catch {
      $("view").replaceChildren(h("div", { class: "banner err" }, "This browser blocked storage, so meetings can’t be saved. Turn off Private Browsing and reopen the app."));
      return;
    }
    render();
  })();

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    // When a new version is published, switch to it right away (but never mid-recording or mid-processing).
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadController && !rec.active && !jobs.size) location.reload();
    });
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
