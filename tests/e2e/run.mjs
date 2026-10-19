// Запись в настоящем headless Chrome: холст вместо экрана, осциллятор вместо микрофона, сервер-подделка вместо хаба.
// Запуск: node tests/e2e/run.mjs [сценарий]  (Chrome — из VF_CHROME или из обычных мест; нет Chrome — код 77, «пропущено»)
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
if (!chrome) { console.log("нет Chrome — пропущено"); process.exit(77); }

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const until = async (fn, what, ms = 60000) => {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error(`не дождался: ${what}`);
    await sleep(200);
  }
};
const check = (cond, what) => { if (!cond) throw new Error(`НЕ ТАК: ${what}`); console.log(`ok  ${what}`); };

// ───── хаб-подделка: ничего не кэширует, умеет «перезапуститься» посреди загрузки видео ─────
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
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"); } catch { /* не JSON */ }
      const reply = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (url.pathname === "/api/voice") { s.voice++; return reply(200, { text: `фраза ${s.voice}` }); }
      if (url.pathname === "/api/upload") {
        if (s.dieOnVideo && /^screen-video/.test(body.name || "") && s.restarts < s.dieOnVideo) {
          s.restarts++;
          return s.restart();   // хаб перезапустился посреди загрузки видео: соединение рвётся, порт молчит 3 с
        }
        const data = Buffer.from(body.data || "", "base64");
        const p = path.join(s.dir, `${s.uploads.length}-${body.name}`);
        fs.writeFileSync(p, data);
        s.uploads.push({ name: body.name, mime: body.mime, size: data.length, path: p });
        return reply(200, { path: p, name: body.name, mime: body.mime, size: data.length });
      }
      if (url.pathname === "/__send") {
        if (s.failSends) { s.failSends--; return reply(503, { error: "хаб занят" }); }
        s.sends.push(body);
        return reply(200, { ok: true });
      }
      reply(404, { error: "нет" });
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

// ───── Chrome через CDP ─────
async function launch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-chrome-"));   // свежий профиль: кэш старого main.js не мешает
  const proc = spawn(chrome, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run",
    "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required", "--disable-extensions", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] });
  const ws = await new Promise((ok, bad) => {
    let err = "";
    proc.stderr.on("data", (d) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) ok(m[1]); });
    proc.on("exit", () => bad(new Error("Chrome вышел: " + err.slice(-500))));
    setTimeout(() => bad(new Error("Chrome не запустился")), 20000);
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
    if (r.exceptionDetails) throw new Error("страница: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  return { page, ev, close: () => { try { browser.close(); } catch { /* уже закрыт */ } proc.kill(); } };
}

const held = (b) => b.ev("document.documentElement.hasAttribute('data-hub-hold')");
const phase = (b) => b.ev("globalThis.__videoFeedback?.()?.phase || null");

async function load(b, h) {
  await b.page("Page.navigate", { url: `http://127.0.0.1:${h.port}/` });
  await until(() => b.ev("window.__ready === true").catch(() => false), "страница-обвязка");
}

async function record(b, seconds) {
  await b.ev("window.__root.querySelector('.vf-btn').click()");
  await until(async () => (await phase(b)) === "rec", "идёт запись", 20000);
  await sleep(seconds * 1000);
}

const isWebm = (p) => { const b = fs.readFileSync(p); return b.length > 1000 && b.readUInt32BE(0) === 0x1a45dfa3; };
const videos = (h) => h.uploads.filter((u) => /^screen-video/.test(u.name)).sort((a, b) => (a.name < b.name ? -1 : 1));

// 1. обычная остановка: видео доходит файлом, путь — в тексте сообщения
async function normal() {
  const h = newHub();
  await h.listen();
  const b = await launch();
  try {
    await load(b, h);
    await record(b, 6);
    check(await held(b), "пока идёт запись, страница держится (data-hub-hold)");
    await b.ev("window.__root.querySelector('.vf-btn').click()");
    await until(() => h.sends.length, "сообщение в чат");
    const text = h.sends[0].text;
    const vids = videos(h);
    check(vids.length === 1, `видео загружено одним файлом (${vids.length})`);
    check(vids.length === 1 && isWebm(vids[0].path), "это настоящий webm");
    check(!text.includes("Видео не сохранилось"), "в тексте нет «Видео не сохранилось»");
    check(vids.length === 1 && text.includes(vids[0].path), "в тексте путь к видео");
    check(h.uploads.some((u) => /^screen-.*\.jpg$/.test(u.name)), "кадры тоже дошли");
    check(h.sends.length === 1, "сообщение одно");
    await until(async () => !(await held(b)), "страница отпущена после доставки", 10000);
    check(true, "после подтверждённой доставки страница отпущена");
  } finally { b.close(); h.close(); }
}

// 2. хаб перезапустился посреди загрузки видео (дважды) и отказал в первой отправке — всё равно дошло, сообщение одно
async function restartMidSend() {
  const h = newHub({ dieOnVideo: 2, failSends: 1 });
  await h.listen();
  const b = await launch();
  try {
    await load(b, h);
    await record(b, 6);
    await b.ev("window.__root.querySelector('.vf-btn').click()");
    await until(() => h.restarts === 1, "хаб перезапустился посреди загрузки видео", 60000);
    check(await held(b) && !h.sends.length, "хаб лежит, ничего не доставлено — страница держится");
    await until(() => h.sends.length, "сообщение в чат после перезапусков хаба", 120000);
    const vids = videos(h);
    check(h.restarts === 2, `хаб перезапускался дважды (${h.restarts})`);
    check(vids.length === 1 && isWebm(vids[0].path), "видео дошло целиком после перезапусков");
    check(vids.length === 1 && h.sends[0].text.includes(vids[0].path), "путь к видео — в тексте");
    check(h.sends.length === 1, "сообщение одно");
  } finally { b.close(); h.close(); }
}

// 3. страницу обновили посреди записи — после загрузки запись досылается сама, видео с ней
async function reloadMidRecording() {
  const h = newHub();
  await h.listen();
  const b = await launch();
  try {
    await load(b, h);
    await record(b, 6);
    await load(b, h);   // запись оборвалась, страница открылась заново
    await until(() => h.sends.length, "запись, досланная после перезагрузки", 90000);
    const vids = videos(h);
    check(vids.length === 1 && isWebm(vids[0].path), "оборванная запись: видео дошло");
    check(vids.length === 1 && h.sends[0].text.includes(vids[0].path), "путь к видео — в тексте");
    check(h.sends.length === 1, "сообщение одно");
  } finally { b.close(); h.close(); }
}

const only = process.argv[2];
const cases = { normal, restartMidSend, reloadMidRecording };
let failed = 0;
for (const [name, fn] of Object.entries(cases)) {
  if (only && only !== name) continue;
  console.log(`— ${name}`);
  try { await fn(); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}
process.exit(failed ? 1 : 0);
