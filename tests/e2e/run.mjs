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
      if (url.pathname === "/api/voice") {
        const n = ++s.voice;
        s.busy = (s.busy || 0) + 1;
        s.maxBusy = Math.max(s.maxBusy || 0, s.busy);
        return setTimeout(() => { s.busy--; reply(200, { text: `phrase ${n}` }); }, s.voiceDelay || 0);
      }
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
  // gallery: a fake Motion Gallery on the hub port + 12 (where the plugin looks for it), with CORS: the page is another origin
  s.listenGallery = () => new Promise((ok, bad) => {
    const g = http.createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      const head = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
      if (url.pathname === "/gallery.json") {
        res.writeHead(200, { ...head, "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ready: true, configured: true, items: GALLERY }));
      }
      const m = /^\/posters\/(\d+)\.svg$/.exec(url.pathname);
      if (m) {
        res.writeHead(200, { ...head, "Content-Type": "image/svg+xml" });
        return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="hsl(${m[1] * 70} 60% 50%)"/></svg>`);
      }
      res.writeHead(404, head);
      res.end();
    });
    g.on("error", bad);
    g.listen(s.port + 12, "127.0.0.1", () => { s.galleryServer = g; ok(); });
  });
  const listenOnly = s.listen;
  s.listen = async () => {
    if (!s.gallery || s.galleryServer) return listenOnly();
    for (let i = 0; i < 20; i++) {   // the hub port + 12 must be free too
      s.port = 0;
      await listenOnly();
      if (s.port + 12 > 65535) { s.server.close(); continue; }
      try { await s.listenGallery(); return; } catch { s.server.close(); }
    }
    throw new Error("no free pair of ports for the hub and the gallery");
  };
  s.restart = () => {
    for (const c of s.connections) c.destroy();
    s.server.close();
    setTimeout(() => s.listen(), 3000);
  };
  s.close = () => { for (const c of s.connections) c.destroy(); s.server?.close(); s.galleryServer?.close(); s.galleryServer?.closeAllConnections?.(); };
  return s;
}

const GALLERY = [
  { slug: "fade-in", title: "Soft fade in", tags: ["fade"], duration: 2.4, poster: "/posters/1.svg" },
  { slug: "slide-up", title: "Slide up", tags: ["move"], duration: 1.8, poster: "/posters/2.svg" },
  { slug: "bounce", title: "Bounce pop", tags: ["spring"], duration: 3, poster: "/posters/3.svg" },
  { slug: "typewriter", title: "Typewriter text", tags: ["text"], duration: 65, poster: "/posters/4.svg" },
];

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

async function load(b, h, query = "") {
  await b.page("Page.navigate", { url: `http://127.0.0.1:${h.port}/${query}` });
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

// 5. a slow transcription (a local whisper loading its model per phrase): after the stop the page says how many phrases
// are done, the tab title too, two phrases go at once; then the message arrives and the title comes back
async function slowVoice() {
  const h = newHub({ voiceDelay: 7000 });
  await h.listen();
  const b = await launch();
  try {
    await load(b, h, "?pulse");
    const title = await b.ev("document.title");
    await record(b, 12);
    await b.ev("window.__root.querySelector('.vf-btn').click()");
    const said = await until(() => b.ev("document.querySelector('.vf-banner')?.textContent || ''")
      .then((x) => (/^Transcribing phrases: \d+ of \d+/.test(x) ? x : "")), "the transcription progress on the page", 20000);
    check(true, `the page says it: ${said.slice(0, 40)}`);
    check(/^◌ \d+\/\d+ · transcribing$/.test(await b.ev("document.title")), "the tab title shows the progress");
    await until(() => h.sends.length, "the message in the chat", 90000);
    check(h.voice >= 4, `several phrases (${h.voice})`);
    check(h.maxBusy === 2, `two phrases transcribed at once, not more (${h.maxBusy})`);
    check((h.sends[0].text.match(/“phrase \d+”/g) || []).length === h.voice, "every phrase has its text");
    check((await b.ev("document.title")) === title, "the tab title is back");
    check(h.sends.length === 1, "one message");
  } finally { b.close(); h.close(); }
}

// ───── the drawing island ─────
// a real mouse through CDP (pointer events reach the canvas the way a hand's do)
const mouse = (b, type, x, y) => b.page("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
async function drag(b, a, c) {
  await mouse(b, "mouseMoved", a[0], a[1]);
  await mouse(b, "mousePressed", a[0], a[1]);
  for (let i = 1; i <= 6; i++) await mouse(b, "mouseMoved", a[0] + ((c[0] - a[0]) * i) / 6, a[1] + ((c[1] - a[1]) * i) / 6);
  await mouse(b, "mouseReleased", c[0], c[1]);
}
const tool = (b, id) => b.ev(`document.querySelector('.vfd-btn[data-tool="${id}"]').click()`);
const rec = (b) => b.ev("globalThis.__videoFeedback?.()");
const pixel = (b, x, y) => b.ev(`(() => { const d = document.querySelector('.vf-draw').getContext('2d').getImageData(${x}, ${y}, 1, 1).data; return [d[0], d[1], d[2], d[3]]; })()`);
async function view(b, w = 1000, h = 700) { await b.page("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }); }
async function island(b, seconds = 1) {
  await record(b, 0);
  await until(() => b.ev("!!document.querySelector('.vfd-island')"), "the island is on the screen", 10000);
  await sleep(seconds * 1000);
}

// 6. four tools: each one is a toggle, draws a stroke, and the recording knows something was drawn
async function drawTools() {
  const h = newHub();
  await h.listen();
  const b = await launch();
  try {
    await load(b, h, "?bg=light");
    await view(b);
    await island(b);
    check(await b.ev("document.querySelector('.vfd-root').parentElement === document.documentElement"), "the island is outside <body> (so it can be cropped away)");
    check(await b.ev("document.querySelectorAll('.vfd-btn[data-tool]').length") === 4, "four tools: pencil, rectangle, oval, line");
    check(!(await rec(b)).drew, "nothing drawn yet");
    let n = 0;
    for (const id of ["pencil", "rect", "oval", "line"]) {
      await tool(b, id);
      check(await b.ev(`document.querySelector('.vfd-btn[data-tool="${id}"]').getAttribute('aria-pressed')`) === "true", `${id}: pressed`);
      await drag(b, [200, 200 + n * 60], [400, 240 + n * 60]);
      n++;
      check(await b.ev("globalThis.__videoFeedback().island.strokes()") === n, `${id}: a stroke is on the screen (${n})`);
    }
    check((await rec(b)).drew === true, "the recording knows it was drawn on");
    await tool(b, "line");
    check(await b.ev("document.querySelector('.vf-draw').classList.contains('vf-on')") === false, "the second click lets go of the tool: clicks go to the page again");
    await tool(b, "rect");
    await b.page("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    check(await b.ev("document.querySelector('.vf-draw').classList.contains('vf-on')") === false, "Escape lets go of the tool");
  } finally { b.close(); h.close(); }
}

// 7. the ink follows the screen: dark on the white half, white on the black half
async function ink() {
  const h = newHub();
  await h.listen();
  const b = await launch();
  try {
    await load(b, h, "?bg=split");
    await view(b);
    await island(b, 1.5);
    await tool(b, "line");
    await drag(b, [150, 300], [250, 300]);
    const onWhite = await pixel(b, 200, 300);
    await drag(b, [750, 300], [850, 300]);
    const onBlack = await pixel(b, 800, 300);
    check(onWhite[3] > 200 && onWhite[0] < 60 && onWhite[2] < 60, `on white the ink is dark (${onWhite})`);
    check(onBlack[3] > 200 && onBlack[0] > 200 && onBlack[2] > 200, `on black the ink is white (${onBlack})`);
    await tool(b, "pencil");
    await drag(b, [150, 400], [850, 400]);
    const left = await pixel(b, 200, 400);
    const right = await pixel(b, 800, 400);
    check(left[0] < 60 && right[0] > 200, `one pencil line changes colour with the screen under it (${left} → ${right})`);
  } finally { b.close(); h.close(); }
}

// 8. close wipes the drawing and hides the island; the pen button next to the bin brings it back
async function closePen() {
  const h = newHub();
  await h.listen();
  const b = await launch();
  try {
    await load(b, h, "?bg=light");
    await view(b);
    await island(b);
    const pen = "window.__root.querySelector('.vf-pen')";
    check(await b.ev(`${pen}.hidden`), "the island is open: no pen button");
    await tool(b, "rect");
    await drag(b, [200, 200], [400, 300]);
    check(await b.ev("globalThis.__videoFeedback().island.strokes()") === 1, "a rectangle is drawn");
    await b.ev("document.querySelector('.vfd-btn[data-act=close]').click()");
    check(await b.ev("globalThis.__videoFeedback().island.isOpen()") === false, "closed");
    check(await b.ev("globalThis.__videoFeedback().island.strokes()") === 0, "the drawing is wiped");
    check(await b.ev("(() => { const r = document.querySelector('.vfd-root'); return !r || getComputedStyle(r).display === 'none'; })()"), "the island is not on the screen");
    await until(() => b.ev(`!${pen}.hidden`), "the pen button appears");
    await b.ev(`${pen}.click()`);
    check(await b.ev("globalThis.__videoFeedback().island.isOpen()") === true, "the pen button brings the island back");
    check(await b.ev(`${pen}.hidden`) === true || await until(() => b.ev(`${pen}.hidden`), "the pen goes away again"), "no pen button while the island is open");
    check(await b.ev("globalThis.__videoFeedback().phase") === "rec", "the recording went on all along");
  } finally { b.close(); h.close(); }
}

// 9. the island takes its colours from the hub theme, and can be dragged by the grip
async function theme() {
  const bgs = {};
  for (const th of ["dark", "light"]) {
    const h = newHub();
    await h.listen();
    const b = await launch();
    try {
      await load(b, h, `?theme=${th}&bg=light`);
      await view(b);
      await island(b, 0.3);
      bgs[th] = await b.ev("getComputedStyle(document.querySelector('.vfd-island')).backgroundColor");
      if (th === "dark") {
        const before = await b.ev("document.querySelector('.vfd-root').offsetLeft");
        await drag(b, [await b.ev("(() => { const r = document.querySelector('.vfd-grip').getBoundingClientRect(); return r.x + r.width / 2; })()"),
          await b.ev("(() => { const r = document.querySelector('.vfd-grip').getBoundingClientRect(); return r.y + r.height / 2; })()")], [300, 400]);
        const after = await b.ev("[document.querySelector('.vfd-root').offsetLeft, document.querySelector('.vfd-root').offsetTop]");
        check(after[0] !== before && after[1] > 100, `the grip drags the island (${before} → ${after})`);
        check(await b.ev("!!localStorage.getItem('hub-video-feedback:island')"), "the place is remembered");
      }
    } finally { b.close(); h.close(); }
  }
  check(bgs.dark === "rgb(38, 38, 43)", `dark theme: dark island (${bgs.dark})`);
  check(bgs.light === "rgb(255, 255, 255)", `light theme: light island (${bgs.light})`);
}

// 10. Motion Gallery installed: its icon is on the island; a card puts a tag at the moment of the click, the tag goes
// into the message with its time, and Undo takes it back
async function tagMg() {
  const h = newHub({ gallery: true });
  await h.listen();
  const b = await launch();
  try {
    await load(b, h, "?bg=light");
    await view(b);
    await island(b, 0.5);
    const btn = "document.querySelector('.vfd-btn[data-act=mg]')";
    await until(() => b.ev(`!${btn}.hidden`), "the Motion Gallery icon appears (the gallery answered)", 20000);
    await b.ev(`${btn}.click()`);
    await until(() => b.ev("document.querySelectorAll('.vfd-card').length === 4"), "four cards in the popover");
    check(await b.ev(`${btn}.getAttribute('aria-expanded')`) === "true", "the icon is pressed while the popover is open");
    const dur = await b.ev("[...document.querySelectorAll('.vfd-card')].map((c) => c.querySelector('.vfd-dur').textContent)");
    check(dur.includes("1:05") && dur.includes("0:03"), `durations on the posters (${dur})`);
    await b.ev("(() => { const f = document.querySelector('.vfd-find'); f.value = 'bounce'; f.dispatchEvent(new Event('input')); })()");
    check(await b.ev("document.querySelectorAll('.vfd-card').length") === 1, "search leaves one card");
    await b.ev("document.querySelector('.vfd-card').click()");
    check(await b.ev("globalThis.__videoFeedback().tags.length") === 1, "one tag is set");
    const tg = (await rec(b)).tags[0];
    check(tg.slug === "bounce" && tg.title === "Bounce pop" && tg.t > 0, `the tag keeps the card and the time (${JSON.stringify(tg)})`);
    check(await b.ev("!!document.querySelector('.vfd-toast')"), "a toast says the tag is placed");
    check(await b.ev("!document.querySelector('.vfd-pop')"), "the popover is closed after the pick");
    await b.ev(`${btn}.click()`);
    await until(() => b.ev("document.querySelectorAll('.vfd-card').length === 4"), "the popover opens again");
    await b.ev("(() => { const f = document.querySelector('.vfd-find'); f.value = 'slide'; f.dispatchEvent(new Event('input')); })()");
    await b.page("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await b.ev("document.querySelector('.vfd-find')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
    await until(async () => (await rec(b)).tags.length === 2, "Enter in the search takes the first card");
    await b.ev("document.querySelector('.vfd-toast-undo').click()");
    check((await rec(b)).tags.filter((x) => x.gone).length === 1, "Undo marks the last tag as taken back");
    await sleep(500);
    await b.ev("window.__root.querySelector('.vf-btn').click()");
    await until(() => h.sends.length, "the message in the chat", 60000);
    const text = h.sends[0].text;
    check(/\d+:\d\d · Motion Gallery: Bounce pop \(bounce\)/.test(text), `the message has the tag with its time (${text.slice(0, 400)})`);
    check(!text.includes("(slide-up)"), "the tag taken back is not in the message");
    check(text.includes("Animation tags:"), "the message says what the tags mean");
    check(h.sends[0].metas?.length >= 1, "the frame of the tag is among the pictures");
  } finally { b.close(); h.close(); }
}

// 11. no Motion Gallery: no icon on the island
async function noGallery() {
  const h = newHub();
  await h.listen();
  const b = await launch();
  try {
    await load(b, h, "?bg=light");
    await view(b);
    await island(b, 4);
    check(await b.ev("document.querySelector('.vfd-btn[data-act=mg]').hidden"), "no gallery: no Motion Gallery icon");
    check(await b.ev("document.querySelectorAll('.vfd-btn[data-tool]').length") === 4, "the drawing tools are there anyway");
  } finally { b.close(); h.close(); }
}

// 12. a browser tab can be cropped to <body> (the island is left out of the video); a screen or a window cannot
async function confine() {
  for (const tab of [true, false]) {
    const h = newHub();
    await h.listen();
    const b = await launch();
    try {
      await load(b, h, tab ? "?tab" : "");
      await island(b, 0.3);
      const r = await rec(b);
      check(r.confined === tab, `${tab ? "tab" : "screen"}: confined is ${tab}`);
      check(await b.ev("window.__restricted || null") === (tab ? "BODY" : null), tab ? "the stream is cropped to <body>" : "the stream is not cropped");
    } finally { b.close(); h.close(); }
  }
}

const only = process.argv[2];
const cases = { normal, restartMidSend, reloadMidRecording, russian, slowVoice, drawTools, ink, closePen, theme, tagMg, noGallery, confine };
let failed = 0;
for (const [name, fn] of Object.entries(cases)) {
  if (only && only !== name) continue;
  console.log(`- ${name}`);
  try { await fn(); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}
process.exit(failed ? 1 : 0);
