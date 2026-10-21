// A recording in a real headless Chrome: a canvas instead of the screen, an oscillator instead of the microphone, a fake
// server instead of the hub. Run: node tests/e2e/run.mjs [scenario]  (Chrome comes from VF_CHROME or the usual places;
// no Chrome: exit code 77, "skipped"). Chrome gets its own throwaway profile and a random debugging port (port 0).
// The page is served from the plugin folder; the harness hub has no language (so en) until a scenario sets hub.lang.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHROMES = [process.env.VF_CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean);
const chrome = CHROMES.find((p) => fs.existsSync(p));
if (!chrome) { console.log("no Chrome - skipped"); process.exit(77); }

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const until = async (fn, what, ms = 60000) => {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error(`timed out waiting for: ${what}`);
    await sleep(200);
  }
};
const check = (cond, what) => { if (!cond) throw new Error(`WRONG: ${what}`); console.log(`ok  ${what}`); };

// ───── fake hub: caches nothing, can "restart" in the middle of a video upload ─────
function newHub(opts = {}) {
  const s = { uploads: [], sends: [], voice: 0, restarts: 0, port: 0, server: null, connections: new Set(), ...opts };
  s.dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-hub-"));
  s.handler = (req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET") {
      const file = url.pathname === "/" ? "tests/e2e/harness.html" : url.pathname.slice(1);
      const full = path.join(ROOT, file);
      if (!full.startsWith(ROOT) || !fs.existsSync(full)) { res.writeHead(404); return res.end(); }
      const type = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css" }[path.extname(full)] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": type + "; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(fs.readFileSync(full));
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"); } catch { /* not JSON */ }
      const reply = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (url.pathname === "/api/voice") { s.voice++; return reply(200, { text: `phrase ${s.voice}` }); }
      if (url.pathname === "/api/upload") {
        if (s.dieOnVideo && /^screen-video/.test(body.name || "") && s.restarts < s.dieOnVideo) {
          s.restarts++;
          return s.restart();   // the hub restarted in the middle of a video upload: the connection drops, the port is silent for 3 s
        }
        const data = Buffer.from(body.data || "", "base64");
        const p = path.join(s.dir, `${s.uploads.length}-${body.name}`);
        fs.writeFileSync(p, data);
        s.uploads.push({ name: body.name, mime: body.mime, size: data.length, path: p });
        return reply(200, { path: p, name: body.name, mime: body.mime, size: data.length });
      }
      if (url.pathname === "/__send") {
        if (s.failSends) { s.failSends--; return reply(503, { error: "hub busy" }); }
        s.sends.push(body);
        return reply(200, { ok: true });
      }
      reply(404, { error: "not found" });
    });
  };
  s.listen = () => new Promise((ok) => {
    s.server = http.createServer(s.handler);
    s.server.on("connection", (c) => { s.connections.add(c); c.on("close", () => s.connections.delete(c)); });
    s.server.listen(s.port, "127.0.0.1", () => { s.port = s.server.address().port; ok(); });
  });
  s.restart = () => {
    for (const c of s.connections) c.destroy();
    s.server.close();
    setTimeout(() => s.listen(), 3000);
  };
  s.close = () => { for (const c of s.connections) c.destroy(); s.server?.close(); };
  return s;
}

// ───── Chrome over CDP ─────
async function launch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-chrome-"));   // a fresh profile: the cache of an old main.js does not interfere
  const proc = spawn(chrome, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run",
    "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required", "--disable-extensions", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] });
  const ws = await new Promise((ok, bad) => {
    let err = "";
    proc.stderr.on("data", (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) ok(m[1]); });
    proc.on("exit", () => bad(new Error("Chrome exited: " + err.slice(-500))));
    setTimeout(() => bad(new Error("Chrome did not start")), 20000);
  });
  const browser = new WebSocket(ws);
  await new Promise((ok) => (browser.onopen = ok));
  let id = 0;
  const waiting = new Map();
  browser.onmessage = (m) => { const j = JSON.parse(m.data); waiting.get(j.id)?.(j); };
  const send = (method, params = {}, sessionId) => new Promise((ok, bad) => {
    const n = ++id;
    waiting.set(n, (j) => (j.error ? bad(new Error(JSON.stringify(j.error))) : ok(j.result)));
    browser.send(JSON.stringify({ id: n, method, params, sessionId }));
  });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  await page("Page.enable");
  await page("Runtime.enable");
  const ev = async (expr) => {
    const r = await page("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  return { page, ev, close: () => { try { browser.close(); } catch { /* already closed */ } proc.kill(); } };
}

const held = (b) => b.ev("document.documentElement.hasAttribute('data-hub-hold')");
const phase = (b) => b.ev("globalThis.__videoFeedback?.()?.phase || null");

async function load(b, h) {
  await b.page("Page.navigate", { url: `http://127.0.0.1:${h.port}/` });
  await until(() => b.ev("window.__ready === true").catch(() => false), "the harness page");
}

async function record(b, seconds) {
  await b.ev("window.__root.querySelector('.vf-btn').click()");
  await until(async () => (await phase(b)) === "rec", "recording is running", 20000);
  await sleep(seconds * 1000);
}

const isWebm = (p) => { const b = fs.readFileSync(p); return b.length > 1000 && b.readUInt32BE(0) === 0x1a45dfa3; };
const videos = (h) => h.uploads.filter((u) => /^screen-video/.test(u.name)).sort((a, b) => (a.name < b.name ? -1 : 1));

// 1. a normal stop: the video arrives as a file, the path is in the message text
async function normal() {
  const h = newHub();
  await h.listen();
  const b = await launch();
  try {
    await load(b, h);
    await record(b, 6);
    check(await held(b), "while recording, the page is held (data-hub-hold)");
    await b.ev("window.__root.querySelector('.vf-btn').click()");
    await until(() => h.sends.length, "the message in the chat");
    const text = h.sends[0].text;
    const vids = videos(h);
    check(vids.length === 1, `the video was uploaded as one file (${vids.length})`);
    check(vids.length === 1 && isWebm(vids[0].path), "it is a real webm");
    check(text.startsWith("Video feedback, "), "the message is in English by default");
    check(/“phrase \d+”/.test(text), "the phrase is in English quotes");
    check(!text.includes("The video was not saved"), "the text does not say \"The video was not saved\"");
    check(vids.length === 1 && text.includes(vids[0].path), "the text has the video path");
    check(h.uploads.some((u) => /^screen-.*\.jpg$/.test(u.name)), "the frames arrived too");
    check(h.sends.length === 1, "one message");
    await until(async () => !(await held(b)), "the page is released after delivery", 10000);
    check(true, "after a confirmed delivery the page is released");
  } finally { b.close(); h.close(); }
}

// 2. the hub restarted in the middle of the video upload (twice) and refused the first send: it still arrived, one message
async function restartMidSend() {
  const h = newHub({ dieOnVideo: 2, failSends: 1 });
  await h.listen();
  const b = await launch();
  try {
    await load(b, h);
    await record(b, 6);
    await b.ev("window.__root.querySelector('.vf-btn').click()");
    await until(() => h.restarts === 1, "the hub restarted in the middle of the video upload", 60000);
    check(await held(b) && !h.sends.length, "the hub is down, nothing delivered: the page is held");
    await until(() => h.sends.length, "the message in the chat after the hub restarts", 120000);
    const vids = videos(h);
    check(h.restarts === 2, `the hub restarted twice (${h.restarts})`);
    check(vids.length === 1 && isWebm(vids[0].path), "the whole video arrived after the restarts");
    check(vids.length === 1 && h.sends[0].text.includes(vids[0].path), "the video path is in the text");
    check(h.sends.length === 1, "one message");
  } finally { b.close(); h.close(); }
}

// 3. the page was reloaded in the middle of a recording: after loading, the recording is sent by itself, the video with it
async function reloadMidRecording() {
  const h = newHub();
  await h.listen();
  const b = await launch();
  try {
    await load(b, h);
    await record(b, 6);
    await load(b, h);   // the recording was cut off, the page opened anew
    await until(() => h.sends.length, "the recording sent after the reload", 90000);
    const vids = videos(h);
    check(vids.length === 1 && isWebm(vids[0].path), "cut-off recording: the video arrived");
    check(vids.length === 1 && h.sends[0].text.includes(vids[0].path), "the video path is in the text");
    check(h.sends.length === 1, "one message");
  } finally { b.close(); h.close(); }
}

// 4. the hub language is Russian (it is switched after the page loaded: the language is read at use time): the button
// hint and the message to the session are in Russian, the format is the same
async function russian() {
  const h = newHub();
  await h.listen();
  const b = await launch();
  try {
    await load(b, h);
    check((await b.ev("window.__root.querySelector('.vf-btn').title")).startsWith("Record the screen and voice"), "the button hint is in English at first");
    await b.ev("window.__hub.lang = 'ru'");
    await record(b, 6);
    check((await b.ev("window.__root.querySelector('.vf-btn').title")) === "Остановить и отправить", "the button hint switched to Russian");
    await b.ev("window.__root.querySelector('.vf-btn').click()");
    await until(() => h.sends.length, "the message in the chat");
    const text = h.sends[0].text;
    const vids = videos(h);
    check(text.startsWith("Видео-фидбэк, "), "the message is in Russian");
    check(text.includes("Видео экрана — путь внизу"), "the Russian text points to the video path");
    check(vids.length === 1 && text.includes(vids[0].path), "the video path is in the text");
    check(/\[Image #1\]/.test(text), "the [Image #N] marks are the same");
    check(/«phrase \d+»/.test(text), "the phrase is in the Russian quotes");
  } finally { b.close(); h.close(); }
}

const only = process.argv[2];
const cases = { normal, restartMidSend, reloadMidRecording, russian };
let failed = 0;
for (const [name, fn] of Object.entries(cases)) {
  if (only && only !== name) continue;
  console.log(`- ${name}`);
  try { await fn(); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}
process.exit(failed ? 1 : 0);
