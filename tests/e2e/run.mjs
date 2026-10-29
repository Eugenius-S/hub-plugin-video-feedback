// A recording in a real headless Chrome: a canvas instead of the screen, an oscillator instead of the microphone, a fake
// server instead of the hub. Run: node tests/e2e/run.mjs [scenario]  (Chrome comes from VF_CHROME or the usual places;
// no Chrome: exit code 77, "skipped"). Chrome gets its own throwaway profile and a random debugging port (port 0).
// The page is served from the plugin folder; the harness hub has no language (so en) until a scenario sets hub.lang.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import zlib from "node:zlib";
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
  const mode = process.env.VF_HEADED ? ["--window-position=60,40", "--window-size=1296,800"] : ["--headless=new"];   // VF_HEADED: a real window with the GPU
  const proc = spawn(chrome, [...mode, "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run",
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
  // a reload after a trusted click would stop on the "leave the page?" dialog of a running recording: accept it
  browser.onmessage = (m) => {
    const j = JSON.parse(m.data);
    waiting.get(j.id)?.(j);
    if (j.method === "Page.javascriptDialogOpening") browser.send(JSON.stringify({ id: ++id, method: "Page.handleJavaScriptDialog", params: { accept: true }, sessionId: j.sessionId }));
  };
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
const pixel = async (b, x, y) => { await sleep(150); return pixelNow(b, x, y); };   // the ink is painted by the next animation frame
const pixelNow = (b, x, y) => b.ev(`(() => { const d = document.querySelector('.vf-draw').getContext('2d').getImageData(${x}, ${y}, 1, 1).data; return [d[0], d[1], d[2], d[3]]; })()`);
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

// a screenshot of the page as the user sees it -> {w, h, px(x, y)}: 8-bit PNG from Chrome (RGB or RGBA, no interlace)
async function shot(b) {
  const png = Buffer.from((await b.page("Page.captureScreenshot", { format: "png" })).data, "base64");
  let w = 0, h = 0, bpp = 4, idat = [];
  for (let i = 8; i < png.length;) {
    const len = png.readUInt32BE(i), type = png.toString("latin1", i + 4, i + 8), body = png.subarray(i + 8, i + 8 + len);
    if (type === "IHDR") { w = body.readUInt32BE(0); h = body.readUInt32BE(4); bpp = body[9] === 6 ? 4 : 3; }
    if (type === "IDAT") idat.push(body);
    i += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), row = w * bpp, out = Buffer.alloc(h * row);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (row + 1)], src = raw.subarray(y * (row + 1) + 1, (y + 1) * (row + 1));
    for (let x = 0; x < row; x++) {
      const left = x >= bpp ? out[y * row + x - bpp] : 0, up = y ? out[(y - 1) * row + x] : 0, ul = x >= bpp && y ? out[(y - 1) * row + x - bpp] : 0;
      const pa = Math.abs(up - ul), pb = Math.abs(left - ul), pc = Math.abs(left + up - 2 * ul);
      const pred = f === 0 ? 0 : f === 1 ? left : f === 2 ? up : f === 3 ? (left + up) >> 1 : pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
      out[y * row + x] = (src[x] + pred) & 255;
    }
  }
  return { w, h, px: (x, y) => [...out.subarray(y * row + x * bpp, y * row + x * bpp + 3)] };
}

// 7. the ink: one colour for every tool, drawn as it is (no blending), so it shows the same on a white, a light grey and a black
// page; the same with the crop of the tab, where the body is isolated and has to paint the page colour itself
const near = (p, c, d = 8) => p.every((v, i) => Math.abs(v - c[i]) <= d);
const DEFAULT_INK = [255, 59, 48];
async function ink() {
  for (const tab of [false, true]) {
    const h = newHub();
    await h.listen();
    const b = await launch();
    try {
      await load(b, h, tab ? "?tab" : "");
      await view(b);
      await island(b, 1.5);
      await b.ev(`document.body.insertAdjacentHTML("beforeend", '<div style="position:fixed;inset:0 66% 0 0;background:#fff"></div><div style="position:fixed;inset:0 33% 0 34%;background:#d9d9d9"></div><div style="position:fixed;inset:0 0 0 67%;background:#000"></div>')`);
      check(await b.ev("getComputedStyle(document.querySelector('.vf-draw')).mixBlendMode") === "normal", "the stroke canvas does not blend");
      // a screen with a scale other than 100% (Windows 125%, retina): the canvas keeps the size of the viewport in CSS pixels
      await b.page("Emulation.setDeviceMetricsOverride", { width: 900, height: 600, deviceScaleFactor: 2, mobile: false });
      await sleep(300);
      const box = await b.ev("(() => { const r = document.querySelector('.vf-draw').getBoundingClientRect(); return [r.width, r.height, innerWidth, innerHeight]; })()");
      check(box[0] === box[2] && box[1] === box[3], `at scale 2 the stroke canvas is as big as the viewport (${box})`);
      await view(b);
      await sleep(300);
      const spots = [[100, "white"], [500, "light grey"], [900, "black"]];
      await tool(b, "line");
      for (const [x] of spots) await drag(b, [x - 50, 300], [x + 50, 300]);
      await tool(b, "pencil");
      for (const [x] of spots) await drag(b, [x - 50, 400], [x + 50, 400]);
      const tag = tab ? "tab" : "screen";
      check(near(await pixel(b, 100, 300), [...DEFAULT_INK, 255], 2), "the default ink is a saturated red");
      const s = await shot(b);
      for (const [x, bg] of spots) for (const [y, name] of [[300, "line"], [400, "pencil"]]) {
        const p = s.px(x, y);
        check(near(p, DEFAULT_INK), `${tag}: on the ${bg} part the ${name} is the ink colour as it is (${p})`);
      }
      const hb = await b.ev("document.documentElement.style.backgroundColor");
      check(tab ? hb !== "" : hb === "", `${tag}: the page colour is ${tab ? "painted by <html> and <body> while the crop holds" : "left alone"} (${hb})`);
      if (tab) {
        await b.ev("window.__root.querySelector('.vf-btn').click()");
        await until(async () => !(await phase(b)), "the recording stopped", 20000);
        check(await b.ev("document.documentElement.style.backgroundColor + document.body.style.backgroundColor + document.body.style.isolation") === "", "after the stop the page styles are back");
      }
    } finally { b.close(); h.close(); }
  }
}

// 7b. the colour popover: a colour picked once goes to every tool, to the next stroke on the open canvas (earlier strokes keep
// theirs), is remembered, and survives a reload; a broken stored value falls back to the default. The stroke has an edge of the
// opposite lightness (dark round a light ink, light round a dark one), so it shows on any page
async function inkPick() {
  const h = newHub();
  await h.listen();
  const b = await launch();
  const KEY = "hub-video-feedback:ink";
  const cur = () => b.ev("getComputedStyle(document.querySelector('.vfd-color')).getPropertyValue('--ink').trim().toLowerCase()");
  const isOpen = () => b.ev("!!document.querySelector('.vfd-cpop')");
  const toggle = () => b.ev("document.querySelector('.vfd-color').click()");
  const typeHex = (hex) => b.ev(`(() => { const i = document.querySelector('.vfd-hex input'); i.value = "${hex}"; i.dispatchEvent(new Event("input", { bubbles: true })); return i.value; })()`);
  const swatch = (hex) => b.ev(`document.querySelector('.vfd-sw[data-hex="${hex}"]').click()`);
  const key = (k, code, vk) => b.page("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk });
  try {
    await load(b, h, "?bg=light");
    await view(b);
    await b.ev(`localStorage.setItem("${KEY}", "not a colour")`);
    await island(b);
    check(await b.ev("document.querySelectorAll('.vfd-btn[data-act=color]').length") === 1, "one colour button");
    check(await b.ev("(() => { const a = document.querySelector('.vfd-btn[data-act=color]'), g = document.querySelector('.vfd-grip'), t = document.querySelector('.vfd-btn[data-tool]'); return !!(g.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(a.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING); })()"), "the colour button sits between the grip and the tools");
    check(await cur() === "#ff3b30", "a broken stored value: the default colour");
    check(!(await isOpen()), "the popover is closed at first");
    await tool(b, "line");
    await drag(b, [100, 300], [200, 300]);
    check(near(await pixel(b, 150, 300), [...DEFAULT_INK, 255], 2), "the first stroke has the default colour");
    // the edge of a light ink is dark: the row just outside the 4 px core
    { const e = await pixelNow(b, 150, 302); check(e[0] === 0 && e[1] === 0 && e[2] === 0 && e[3] > 60 && e[3] < 200, `a light ink has a dark edge (${e})`); }
    await toggle();
    check(await isOpen(), "a click on the colour button opens the popover");
    check(await b.ev("document.querySelector('.vfd-color').getAttribute('aria-expanded')") === "true", "aria-expanded is true");
    check(await b.ev("document.querySelectorAll('.vfd-sw').length") === 8, "eight ready colours");
    check(await b.ev("document.querySelector('.vfd-sw[aria-checked=true]').dataset.hex") === "#FF3B30", "the current colour is checked");
    check(await b.ev("document.querySelector('.vfd-hex input').value") === "FF3B30", "the hex field shows the colour");
    check(await b.ev("document.querySelector('.vfd-cpop').offsetWidth") === 304, "the popover is 304 px wide");
    // the field takes a colour live and keeps the popover open
    check(await typeHex("2A9D8F") === "2A9D8F", "the hex field takes a colour");
    check(await cur() === "#2a9d8f", "the button shows the new colour");
    check(await b.ev(`localStorage.getItem("${KEY}")`) === "#2A9D8F", "the colour is remembered");
    check(await isOpen(), "typing a colour keeps the popover open");
    await typeHex("zz");
    check(await cur() === "#2a9d8f", "an invalid hex changes nothing");
    // the earlier stroke keeps its colour (checked at once, before it fades)
    check(near(await pixelNow(b, 150, 300), [...DEFAULT_INK, 255], 2), "the stroke drawn before keeps its colour");
    await key("Escape", "Escape", 27);
    check(!(await isOpen()), "Escape closes the popover");
    check(await b.ev("document.querySelector('.vf-draw').classList.contains('vf-on')") === true, "the first Escape does not drop the tool");
    const want = [0x2a, 0x9d, 0x8f, 255];
    for (const [id, a, c] of [["pencil", [100, 400], [200, 400]], ["line", [100, 350], [200, 350]], ["rect", [100, 450], [200, 520]], ["oval", [300, 450], [400, 520]]]) {
      await tool(b, id);
      await drag(b, a, c);
    }
    check(near(await pixel(b, 150, 350), want, 2), "line: the new colour");
    check(near(await pixel(b, 150, 400), want, 2), "pencil: the new colour");
    check(near(await pixel(b, 100, 485), want, 2), "rectangle: the new colour");
    check(near(await pixel(b, 300, 485), want, 2), "oval: the new colour");
    // a ready colour sets the ink and closes the popover; a dark ink has a light edge
    await toggle();
    await swatch("#1C1C1E");
    check(!(await isOpen()), "a ready colour closes the popover");
    check(await cur() === "#1c1c1e", "a ready colour is taken");
    await tool(b, "line");
    await drag(b, [100, 560], [200, 560]);
    check(near(await pixel(b, 150, 560), [0x1c, 0x1c, 0x1e, 255], 2), "the black swatch draws black");
    { const e = await pixelNow(b, 150, 562); check(e[0] === 255 && e[1] === 255 && e[2] === 255 && e[3] > 100, `a dark ink has a light edge (${e})`); }
    // the square and the strip: a drag sets a colour, the popover stays
    await toggle();
    const sv = await b.ev("(() => { const r = document.querySelector('.vfd-sv').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()");
    await drag(b, [sv[0] + sv[2] * 0.2, sv[1] + sv[3] * 0.5], [sv[0] + sv[2] * 0.9, sv[1] + sv[3] * 0.1]);
    check(await isOpen(), "a drag on the square keeps the popover open");
    const c1 = await cur();
    check(/^#[0-9a-f]{6}$/.test(c1) && c1 !== "#1c1c1e", `the square sets a colour (${c1})`);
    check(await b.ev("document.querySelector('.vfd-hex input').value.toLowerCase()") === c1.slice(1), "the hex field follows the square");
    const hu = await b.ev("(() => { const r = document.querySelector('.vfd-hue').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()");
    await drag(b, [hu[0] + 2, hu[1] + hu[3] / 2], [hu[0] + hu[2] * 0.5, hu[1] + hu[3] / 2]);
    check(await cur() !== c1, "the strip changes the hue");
    // keys: arrows move over the ready colours and apply them
    await b.ev("document.querySelector('.vfd-sw').focus()");
    await key("ArrowRight", "ArrowRight", 39);
    check(await cur() === "#ff9500", "an arrow picks the next ready colour");
    await key("Escape", "Escape", 27);
    check(await b.ev("document.activeElement === document.querySelector('.vfd-color')"), "after Escape the focus is back on the colour button");
    // a click outside closes the popover
    await toggle();
    await b.page("Input.dispatchMouseEvent", { type: "mousePressed", x: 500, y: 650, button: "left", buttons: 1, clickCount: 1 });
    await b.page("Input.dispatchMouseEvent", { type: "mouseReleased", x: 500, y: 650, button: "left", buttons: 0, clickCount: 1 });
    check(!(await isOpen()), "a click outside closes the popover");
    // another window of the hub picked a colour: the open canvas follows, an open popover too
    await toggle();
    await b.ev(`dispatchEvent(new StorageEvent("storage", { key: "${KEY}", newValue: "#123456" }))`);
    check(await cur() === "#123456", "a colour picked in another window is taken");
    check(await b.ev("document.querySelector('.vfd-hex input').value") === "123456", "an open popover follows it");
    await b.ev(`dispatchEvent(new StorageEvent("storage", { key: "${KEY}", newValue: "red; x" }))`);
    check(await cur() === "#123456", "a broken value from another window is ignored");
    await typeHex("2A9D8F");
    // after a reload the choice is still there
    await load(b, h, "?bg=light");
    await view(b);
    await island(b);
    check(await cur() === "#2a9d8f", "after a reload the colour is the chosen one");
    await tool(b, "pencil");
    await drag(b, [100, 300], [200, 300]);
    check(near(await pixel(b, 150, 300), want, 2), "after a reload strokes use the chosen colour");
  } finally { b.close(); h.close(); }
}

// 8. stop while the crop of the tab is still being set up (the countdown): the page colours and isolation are put back
async function stopWhileCropping() {
  const h = newHub();
  await h.listen();
  const b = await launch();
  try {
    await load(b, h, "?tab&slowcrop&bg=light");
    await b.ev("window.__root.querySelector('.vf-btn').click()");
    await until(async () => (await phase(b)) === "count", "the countdown", 10000);
    check(await b.ev("document.body.style.isolation") === "isolate", "the crop is being set up: body is isolated");
    await b.ev("window.__root.querySelector('.vf-btn').click()");
    await until(async () => !(await phase(b)), "the countdown was cancelled", 10000);
    await sleep(2200);
    check(await b.ev("document.documentElement.style.backgroundColor + document.body.style.backgroundColor + document.body.style.isolation") === "", "after the stop the page styles are back");
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

// 8b. the island comes back where it was left (also after a reload and after a small window), the tool is not remembered
async function place() {
  const h = newHub();
  await h.listen();
  const b = await launch();
  try {
    await load(b, h, "?bg=light");
    await view(b);
    await island(b, 0.3);
    const at = "(() => { const r = document.querySelector('.vfd-root').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; })()";
    const grip = "(() => { const r = document.querySelector('.vfd-grip').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()";
    const dots = await b.ev("document.querySelectorAll('.vfd-grip svg path').length === 1 && /^M11 18c/.test(document.querySelector('.vfd-grip svg path').getAttribute('d'))");
    check(dots, "the grip is the six dots icon");
    await drag(b, await b.ev(grip), [200, 450]);
    const left = await b.ev(at);
    check(left[1] > 300, `the island is dragged (${left})`);
    await tool(b, "oval");
    await b.ev("document.querySelector('.vfd-btn[data-act=close]').click()");
    await b.ev("window.__root.querySelector('.vf-pen').click()");
    check((await b.ev(at)).join() === left.join(), "closed and opened again: the same place");
    check(await b.ev("document.querySelectorAll('.vfd-btn[aria-pressed=true]').length") === 0, "the tool is not remembered");
    await view(b, 420, 300);
    await sleep(300);
    const small = await b.ev("(() => { const r = document.querySelector('.vfd-island').getBoundingClientRect(); return [r.right <= innerWidth, r.bottom <= innerHeight, r.left >= 0, r.top >= 0]; })()");
    check(small.every(Boolean), `a small window keeps the island on the screen (${small})`);
    await view(b);
    await sleep(300);
    check((await b.ev(at)).join() === left.join(), "a big window again: back to the saved place");
    await b.ev("window.__root.querySelector('.vf-btn').click()");   // stop and send, so the reload cuts nothing off
    await until(() => h.sends.length, "the recording sent", 60000);
    await until(async () => !(await phase(b)), "the recording stopped", 20000);
    await load(b, h, "?bg=light");
    await view(b);
    await island(b, 0.3);
    check((await b.ev(at)).join() === left.join(), "after a reload of the page: the same place");
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
        const where = "(() => { const r = document.querySelector('.vfd-root').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; })()";
        const before = (await b.ev(where))[0];
        await drag(b, [await b.ev("(() => { const r = document.querySelector('.vfd-grip').getBoundingClientRect(); return r.x + r.width / 2; })()"),
          await b.ev("(() => { const r = document.querySelector('.vfd-grip').getBoundingClientRect(); return r.y + r.height / 2; })()")], [300, 400]);
        const after = await b.ev(where);
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

// 15. smoothness while recording: how many frames of the page are longer than a frame, per kind of action (a measurement with
// numbers; the limits are loose, headless Chrome paints in software). VF_PERF_DSF sets the pixel ratio, VF_PERF_THROTTLE slows the CPU down N times, VF_PERF_SCREEN the recorded screen, VF_PERF_JSON a file for the numbers
async function smooth() {
  const h = newHub({ gallery: true });
  await h.listen();
  const b = await launch();
  const dsf = Number(process.env.VF_PERF_DSF) || 1;
  const out = {};
  try {
    await load(b, h, `?bg=light&pulse&screen=${process.env.VF_PERF_SCREEN || "2560x1440"}`);
    if (!process.env.VF_HEADED) await b.page("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: dsf, mobile: false });
    out._run = { label: process.env.VF_LABEL || "", headed: !!process.env.VF_HEADED, dsf, throttle: Number(process.env.VF_PERF_THROTTLE) || 1,
      screen: process.env.VF_PERF_SCREEN || "2560x1440", page: await b.ev("[innerWidth, innerHeight, devicePixelRatio].join('x')"), ua: await b.ev("navigator.userAgent") };
    if (process.env.VF_PERF_THROTTLE) await b.page("Emulation.setCPUThrottlingRate", { rate: Number(process.env.VF_PERF_THROTTLE) });
    await island(b, 1);
    await b.page("Performance.enable");
    await b.ev(`(() => {
      const P = (window.__perf = { on: false, t: [], long: [], ev: [] });
      const loop = (t) => { if (P.on) P.t.push(t); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (P.on) P.long.push(e.duration); }).observe({ type: "longtask" });
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (P.on) P.ev.push(e.duration); }).observe({ type: "event", durationThreshold: 16 });
    })()`);
    const metric = async () => Object.fromEntries((await b.page("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
    const measure = async (name, fn) => {
      await b.ev("(() => { __perf.t = []; __perf.long = []; __perf.ev = []; __perf.on = true; })()");
      const m0 = await metric(), t0 = Date.now();
      await fn();
      await sleep(100);
      const m1 = await metric(), wall = (Date.now() - t0) / 1000;
      const r = await b.ev("(() => { __perf.on = false; return { t: __perf.t, long: __perf.long, ev: __perf.ev }; })()");
      const d = r.t.slice(1).map((x, i) => x - r.t[i]).sort((a, c) => a - c);
      const q = (p) => d.length ? +d[Math.min(d.length - 1, Math.floor(d.length * p))].toFixed(1) : 0;
      out[name] = { frames: d.length, over20: +(100 * d.filter((x) => x > 20).length / Math.max(1, d.length)).toFixed(1), over34: d.filter((x) => x > 34).length,
        p95: q(0.95), max: d.length ? +d[d.length - 1].toFixed(1) : 0, fps: +(d.length / wall).toFixed(1), long: r.long.length, longMax: Math.round(Math.max(0, ...r.long)),
        slowEvents: r.ev.length, busy: +(100 * ((m1.TaskDuration - m0.TaskDuration) / wall)).toFixed(1), script: +(100 * ((m1.ScriptDuration - m0.ScriptDuration) / wall)).toFixed(1),
        layout: +(100 * ((m1.LayoutDuration - m0.LayoutDuration) / wall)).toFixed(1), style: +(100 * ((m1.RecalcStyleDuration - m0.RecalcStyleDuration) / wall)).toFixed(1) };
      console.log(name.padEnd(10), JSON.stringify(out[name]));
    };
    // a hand moves the mouse about every 8 ms; the path is paced by the clock, not by the round trip
    const path = async (pts, ms) => {
      const t0 = Date.now();
      for (let i = 0; i < pts.length; i++) {
        await mouse(b, "mouseMoved", pts[i][0], pts[i][1]);
        const wait = t0 + ((i + 1) * ms) / pts.length - Date.now();
        if (wait > 0) await sleep(wait);
      }
    };
    const scribble = (cx, cy, n) => Array.from({ length: n }, (_, i) => [cx + 300 * Math.cos(i / 25) * (1 - i / (2 * n)), cy + 200 * Math.sin(i / 17)]);
    const grip = "(() => { const r = document.querySelector('.vfd-grip').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()";
    await measure("idle", () => sleep(2000));
    await measure("pencil", async () => {
      await tool(b, "pencil");
      for (let k = 0; k < 3; k++) {
        const pts = scribble(640, 400 + k * 30, 250);
        await mouse(b, "mouseMoved", pts[0][0], pts[0][1]);
        await mouse(b, "mousePressed", pts[0][0], pts[0][1]);
        await path(pts, 2000);
        await mouse(b, "mouseReleased", pts[pts.length - 1][0], pts[pts.length - 1][1]);
      }
    });
    await measure("shapes", async () => {
      for (const id of ["rect", "oval", "line"]) {
        await tool(b, id);
        await mouse(b, "mouseMoved", 200, 200);
        await mouse(b, "mousePressed", 200, 200);
        await path(Array.from({ length: 120 }, (_, i) => [200 + i * 5, 200 + i * 3]), 1000);
        await mouse(b, "mouseReleased", 800, 560);
      }
    });
    await measure("fade", () => sleep(7500));
    await tool(b, "line");   // let go of the tool
    await measure("dragbar", async () => {
      const [gx, gy] = await b.ev(grip);
      await mouse(b, "mouseMoved", gx, gy);
      await mouse(b, "mousePressed", gx, gy);
      await path(Array.from({ length: 250 }, (_, i) => [gx + i * 2, gy + 250 * Math.sin(i / 40) * (i / 250)]), 2000);
      await mouse(b, "mouseReleased", gx + 500, gy);
    });
    let openMs = 0;   // the script time of opening the popover (the click handler up to the forced layout)
    await measure("popover", async () => {
      await until(() => b.ev("!document.querySelector('.vfd-btn[data-act=mg]').hidden"), "the Motion Gallery icon", 20000);
      openMs = await b.ev("(() => { const t = performance.now(); document.querySelector('.vfd-btn[data-act=mg]').click(); return performance.now() - t; })()");
      await until(() => b.ev("document.querySelectorAll('.vfd-card').length === 4"), "cards");
      const [gx, gy] = await b.ev(grip);
      await mouse(b, "mouseMoved", gx, gy);
      await mouse(b, "mousePressed", gx, gy);
      await path(Array.from({ length: 150 }, (_, i) => [gx - i * 2, gy + i * 1.5]), 1200);
      await mouse(b, "mouseReleased", gx - 300, gy + 225);
      await sleep(500);
    });
    await measure("toast", async () => {
      await b.ev("document.querySelector('.vfd-card').click()");
      const [gx, gy] = await b.ev(grip);
      await mouse(b, "mouseMoved", gx, gy);
      await mouse(b, "mousePressed", gx, gy);
      await path(Array.from({ length: 150 }, (_, i) => [gx + i * 3, gy - i]), 1200);
      await mouse(b, "mouseReleased", gx + 450, gy - 150);
      await sleep(1500);
    });
    out.popover.openMs = +openMs.toFixed(1);
    console.log("popover opens in", out.popover.openMs, "ms of script");
    if (process.env.VF_PERF_JSON) fs.writeFileSync(process.env.VF_PERF_JSON, JSON.stringify(out, null, 1));
    for (const k of ["pencil", "shapes", "dragbar", "popover", "toast"]) {
      check(out[k].max < 100, `${k}: no frame longer than 100 ms (${out[k].max})`);
    }
  } finally { b.close(); h.close(); }
}

// snapshots for a review (not part of the default run): the island closed and with the colour popover open, strokes of
// every tool in several inks on a white, a light grey and a black page, in the light and the dark theme; VF_SHOTS = the folder
async function shots() {
  const dir = process.env.VF_SHOTS;
  if (!dir) throw new Error("VF_SHOTS is not set");
  fs.mkdirSync(dir, { recursive: true });
  const save = async (b, name) => fs.writeFileSync(`${dir}/${name}.png`, Buffer.from((await b.page("Page.captureScreenshot", { format: "png" })).data, "base64"));
  for (const th of ["light", "dark"]) {
    const h = newHub();
    await h.listen();
    const b = await launch();
    try {
      await load(b, h, `?theme=${th}&bg=light`);
      await view(b, 1000, 700);
      await b.ev("localStorage.removeItem('hub-video-feedback:ink')");
      await island(b, 0.6);
      await b.ev("(() => { const t = performance.now(); performance.now = () => t; })()");   // strokes do not fade while the shots are taken
      await b.ev("document.documentElement.style.background = document.body.style.background = '#fff'");
      await save(b, `${th}-1-closed`);
      await b.ev("document.querySelector('.vfd-color').click()");
      await sleep(500);
      await save(b, `${th}-2-popover`);
      await b.ev("document.querySelector('.vfd-color').click()");
      await sleep(300);
      const ink = (hex) => b.ev(`(() => { const i = (document.querySelector('.vfd-color').click(), document.querySelector('.vfd-hex input')); i.value = "${hex}"; i.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector('.vfd-color').click(); })()`);
      for (const [bgName, bg] of [["white", "#ffffff"], ["grey", "#d9d9d9"], ["black", "#000000"]]) {
        await b.ev(`document.documentElement.style.background = document.body.style.background = "${bg}"`);
        // one row per ink: red (default), yellow, blue, black, white; each row draws pencil, line, rectangle, oval
        let row = 0;
        for (const hex of ["FF3B30", "FFD60A", "0A84FF", "1C1C1E", "FFFFFF"]) {
          await ink(hex);
          await sleep(200);
          const y = 180 + row * 90;
          await tool(b, "pencil");
          await drag(b, [120, y + 30], [260, y]);
          await tool(b, "line");
          await drag(b, [300, y + 30], [440, y]);
          await tool(b, "rect");
          await drag(b, [480, y - 20], [600, y + 40]);
          await tool(b, "oval");
          await drag(b, [640, y - 20], [760, y + 40]);
          row++;
        }
        await save(b, `${th}-3-strokes-${bgName}`);
        await b.ev("document.querySelector('.vfd-btn[data-act=clear], .vfd-btn[data-act=undo]')?.click()");
        await sleep(100);
      }
    } finally { b.close(); h.close(); }
  }
}

const only = process.argv[2];
const cases = { normal, restartMidSend, reloadMidRecording, russian, slowVoice, drawTools, ink, inkPick, shots, stopWhileCropping, closePen, place, theme, tagMg, noGallery, confine, smooth };
let failed = 0;
for (const [name, fn] of Object.entries(cases)) {
  if (only && only !== name) continue;
  if (!only && (name === "smooth" || name === "shots")) continue;   // a measurement, run on request
  console.log(`- ${name}`);
  try { await fn(); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}
process.exit(failed ? 1 : 0);
