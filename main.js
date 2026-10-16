// Видео-фидбэк: значок рядом с микрофоном → выбор экрана → через 3 с запись экрана и голоса. Остановил — в чат уходит
// расшифровка по фразам и кадры экрана в моменты, о которых говорил. Само видео нигде не пишется: на диск ложатся
// только эти кадры, как вставленные картинки. Распознаёт голос модуль «Голос» хаба (/api/voice) — пока идёт запись.
// До подтверждения доставки фразы, кадры и звук лежат в IndexedDB вкладки: перезапуск хаба или обновление страницы
// их не теряет — отправка повторяется, после перезагрузки досылается сама (16.10: 3 минуты записи пропали при
// перезапуске хаба — отправка упала, страница обновилась на новую версию).
import { FRAMES, MAX_MS, VOICE, changed, clock, diff, message, phrases, pick, sentSummary } from "./lib.js";

const COUNT = 3;
const EDGE = 1568, PIXELS = 1.15e6;   // больше этого модель кадр всё равно уменьшит: лишнее — только вес файла
const TICK = 250;

let R = null;          // идущая запись: {phase: "count" | "rec" | "work", key, ...}
const buttons = new Map();   // ключ поля → кнопка
let hubRef = null;
let pending = [];      // недоставленные записи из IndexedDB (прошлая жизнь вкладки) — дошлёт поле ввода их чата
const resuming = new Set();

globalThis.__videoFeedback = () => R;   // для проверки в песочнице: идущая запись

export default function register(hub) {
  if (!navigator.mediaDevices?.getDisplayMedia) return;   // телефон: записи экрана нет — и значка нет
  hubRef = hub;
  hub.addStyle("style.css");
  // запись или отправка — уход со страницы спросит (а обновление на новую версию хаба подождёт метку data-hub-hold)
  addEventListener("beforeunload", (e) => { if (R && R.phase !== "count") { e.preventDefault(); e.returnValue = ""; } });
  scan();
  hub.addSlot("composer.tools", {
    id: "rec",
    render(root, snap, ctx) {
      root.__ctx = ctx;
      let b = root.firstChild;
      if (!b) {
        b = hub.el("button", "btn round quiet vf-btn");
        b.type = "button";
        b.addEventListener("click", () => (R ? (R.key === root.__ctx.key ? stop() : null) : start(root.__ctx, snap)));
        root.append(b);
      }
      buttons.set(ctx.key, b);
      paint(b, ctx.key);
      if (!R) resume(ctx).catch(() => {});
    },
  });
}

function paint(b, key) {
  const mine = R && R.key === key;
  const phase = mine ? R.phase : R ? "busy" : "idle";
  const sig = phase + (phase === "count" ? R.left : phase === "rec" ? clock(performance.now() - R.t0) : "");
  if (b.dataset.sig === sig) return;
  b.dataset.sig = sig;
  b.className = "btn round quiet vf-btn vf-" + phase;
  b.disabled = phase === "busy" || phase === "work";
  b.replaceChildren();
  if (phase === "count") b.append(hubRef.el("span", "vf-num", String(R.left)));
  else if (phase === "rec") b.append(hubRef.el("span", "vf-dot"), hubRef.el("span", "vf-time", clock(performance.now() - R.t0)));
  else if (phase === "work") b.append(hubRef.el("span", "spin-dot"));
  else b.append(cam());
  const say = {
    idle: "Записать экран и голос. Запись начнётся через 3 секунды после выбора экрана",
    busy: "Запись уже идёт в другом чате",
    count: `Запись через ${R?.left}`,
    rec: "Остановить и отправить",
    work: "Расшифровываю и отправляю…",
  }[phase];
  b.title = say;
  b.setAttribute("aria-label", say);
}

function paintAll() {
  // страница хаба не обновляется сама, пока стоит эта метка: запись идёт или ещё не доставлена
  document.documentElement.toggleAttribute("data-hub-hold", !!R && R.phase !== "count");
  for (const [key, b] of buttons) if (b.isConnected) paint(b, key); else buttons.delete(key);
}

function cam() {
  const ns = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(ns, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("class", "icon");
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("fill-rule", "evenodd");
  p.setAttribute("fill", "currentColor");
  p.setAttribute("d", "M4 6h10a2 2 0 0 1 2 2v2.4l6-3.4v10l-6-3.4V16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"
    + "M4 8v8h10V8zM17.6 11.6 20 10.3v3.4l-2.4-1.3z");
  s.append(p);
  return s;
}

// подпись поверх страницы: отсчёт и ошибки (вкладка хаба может быть не на виду — у кнопки то же самое)
function banner(text, ms) {
  let n = document.querySelector(".vf-banner");
  if (!text) return n?.remove();
  if (!n) { n = hubRef.el("div", "vf-banner"); n.setAttribute("role", "status"); document.body.append(n); }
  n.textContent = text;
  clearTimeout(n.__t);
  if (ms) n.__t = setTimeout(() => n.remove(), ms);
}

async function start(ctx, snap) {
  let screen, mic = null;
  try {
    screen = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "monitor", frameRate: { ideal: 5, max: 10 } },
      audio: false, selfBrowserSurface: "include", surfaceSwitching: "include", monitorTypeSurfaces: "include" });
  } catch (e) {
    if (e?.name !== "NotAllowedError") banner(`Не удалось включить запись экрана: ${e?.message || e}`, 8000);
    return;   // отменили выбор экрана — ничего не было
  }
  try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch { banner("Нет доступа к микрофону, пишу только экран", 5000); }
  R = { phase: "count", left: COUNT, key: ctx.key, ctx, screen, mic, voice: !!snap?.voice, cancelled: false };
  screen.getVideoTracks()[0].addEventListener("ended", () => stop());   // «Закрыть доступ» в полосе браузера
  const r = R;
  for (; r.left > 0; r.left--) {
    banner(`Запись через ${r.left}`);
    paintAll();
    await sleep(1000);
    if (r.cancelled) return;
  }
  banner("");
  record();
}

function record() {
  const r = R;
  r.phase = "rec";
  r.t0 = performance.now();
  r.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  r.wall = Date.now();
  r.frameN = 0;
  r.wholeN = 0;
  r.list = [];          // фразы: {from, speech, to, text}
  r.frames = [];        // кадры: {t, kind, phrase, blob, sig}
  r.jobs = Promise.resolve();
  r.grab = grabber(r.screen.getVideoTracks()[0]);
  r.prevSig = null;
  r.keptSig = null;
  r.ticks = 0;
  r.title = document.title;
  if (r.mic) {
    r.audio = new AudioContext();
    r.an = r.audio.createAnalyser();
    r.an.fftSize = 2048;
    r.audio.createMediaStreamSource(r.mic).connect(r.an);
    r.buf = new Float32Array(r.an.fftSize);
    r.voiceCut = phrases(VOICE);
    r.voiceCut.begin(0);
    r.piece = piece(r.mic);
    // весь звук одним файлом: у фраз нет текста — в хаб, до расшифровки (владелец 15.10); кусками по 5 с — в IndexedDB
    r.whole = piece(r.mic, (b) => keep("blob", `${r.id}/w/${pad(r.wholeN++)}`, b), 5000);
  }
  saveMeta(r);
  // таймер — в отдельном потоке: вкладка хаба во время записи обычно не на виду, и её таймеры браузер притормаживает
  r.worker = new Worker(hubRef.url("tick.js"));
  r.worker.onmessage = () => tick(r);
  r.worker.postMessage(TICK);
  paintAll();
}

// кусок голоса: MediaRecorder идёт непрерывно, режется в паузах (VOICE)
function piece(stream, onChunk, slice) {
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
  const chunks = [];
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
  const done = new Promise((ok) => { rec.onstop = () => ok(new Blob(chunks, { type: rec.mimeType || "audio/webm" })); });
  rec.ondataavailable = (e) => { if (e.data.size) { chunks.push(e.data); onChunk?.(e.data); } };
  rec.start(slice);
  return { stop: () => { if (rec.state !== "inactive") rec.stop(); return done; } };
}

async function tick(r) {
  if (R !== r || r.phase !== "rec") return;
  const t = performance.now() - r.t0;
  if (t >= MAX_MS) return stop();
  r.ticks++;
  if (r.ticks % 20 === 0) saveMeta(r);   // длина — на случай, если вкладку обновят посреди записи
  if (r.ticks % 4 === 0) {
    paintAll();
    document.title = `● ${clock(t)} · запись`;
  }
  if (r.an) {
    r.an.getFloatTimeDomainData(r.buf);
    let s = 0;
    for (const x of r.buf) s += x * x;
    r.rms = Math.sqrt(s / r.buf.length);
    r.peak = Math.max(r.peak || 0, r.rms);
    const step = r.voiceCut.step(t, r.rms);
    if (step.frame) shoot(r, t, "onset");
    if (step.restart) {
      const old = r.piece;
      r.piece = piece(r.mic);   // следующий кусок пишется сразу — в паузе ничего не теряется
      const blob = old.stop();
      if (step.cut) hear(r, step.cut, blob);
    }
  }
  if (r.ticks % 4 === 0 && !r.busySig) {   // раз в секунду — отпечаток экрана: сменился и встал — кадр
    r.busySig = true;
    try {
      const { sig } = await r.grab(false);
      const talking = !r.an || r.voiceCut.speaking();
      const now = performance.now() - r.t0;
      if (!r.an && !r.keptSig) shoot(r, now, "change");   // без микрофона фраз нет — первый кадр сразу
      else if (sig && talking && r.keptSig && changed(sig, r.prevSig, r.keptSig)) shoot(r, now, "change");
      r.prevSig = sig;
    } catch { /* кадр не снялся — следующий через секунду */ }
    r.busySig = false;
  }
}

// фраза закончилась: распознать её сейчас же, пока идёт запись (к остановке почти всё уже готово)
function hear(r, cut, blob) {
  const p = { ...cut, text: "", blob };
  const i = r.list.push(p) - 1;
  blob.then((b) => { p.blob = b; return keep("blob", `${r.id}/p/${pad(i)}`, b); }).then(() => saveMeta(r));
  if (!r.voice) return;
  r.jobs = r.jobs.then(() => transcribe(p)).then(() => saveMeta(r));
}

// фраза → текст; хаб не ответил (перезапуск) — ещё раз при отправке
async function transcribe(p) {
  try {
    const b = await p.blob;
    const res = await hubRef.post("/api/voice", { data: await base64(b), mime: b.type });
    p.text = String(res?.data?.text || "").trim();
  } catch { /* не разобрал — в сообщении так и будет */ }
}

async function shoot(r, t, kind) {
  const phrase = r.list.length;   // фраза, что идёт сейчас
  try {
    const { sig, blob } = await r.grab(true);
    if (r.keptSig && diff(sig, r.keptSig) < FRAMES.same) return;   // тот же экран — второй кадр не нужен
    r.keptSig = sig;
    const n = r.frameN++;
    r.frames.push({ t, kind, phrase, blob, n });
    keep("blob", `${r.id}/f/${pad(n)}`, blob).then(() => saveMeta(r));
  } catch { /* без этого кадра */ }
}

// снимок экрана: отпечаток 32×18 и, если надо, JPEG с длинной стороной до EDGE
function grabber(track) {
  const cap = "ImageCapture" in window ? new ImageCapture(track) : null;
  let video = null;
  const small = document.createElement("canvas");
  small.width = 32; small.height = 18;
  const sctx = small.getContext("2d", { willReadFrequently: true });
  return async (full) => {
    let src;
    if (cap) src = await cap.grabFrame();
    else {
      if (!video) { video = document.createElement("video"); video.muted = true; video.srcObject = new MediaStream([track]); await video.play(); }
      src = video;
    }
    const w = src.width || src.videoWidth, h = src.height || src.videoHeight;
    sctx.drawImage(src, 0, 0, 32, 18);
    const px = sctx.getImageData(0, 0, 32, 18).data;
    const sig = new Uint8Array(32 * 18);
    for (let i = 0; i < sig.length; i++) sig[i] = (px[i * 4] * 3 + px[i * 4 + 1] * 6 + px[i * 4 + 2]) / 10;
    let blob = null;
    if (full) {
      const k = Math.min(1, EDGE / Math.max(w, h), Math.sqrt(PIXELS / (w * h)));
      const c = document.createElement("canvas");
      c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
      blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.82));
    }
    src.close?.();
    return { sig, blob };
  };
}

async function stop() {
  const r = R;
  if (!r) return;
  if (r.phase === "count") { r.cancelled = true; release(r); R = null; banner(""); return paintAll(); }
  if (r.phase !== "rec") return;
  r.phase = "work";
  const length = performance.now() - r.t0;
  r.worker.terminate();
  document.title = r.title;
  paintAll();
  let whole = null;
  if (r.an) {
    const last = r.voiceCut.finish(length);
    const blob = r.piece.stop();
    if (last) hear(r, last, blob);
    whole = r.whole.stop();
  }
  release(r);
  try {
    await r.jobs;
    r.length = length;
    r.stopped = true;
    await saveMeta(r);
    await deliver({ ...meta(r), list: r.list, frames: r.frames, whole: whole ? await whole : null }, r.ctx);
  } finally {
    R = null;
    paintAll();
  }
}

// доставка: кадры, звук (если у фраз нет текста), сообщение. Хаб не ответил (перезапуск) — повтор; из IndexedDB запись
// уходит только после того, как хаб принял сообщение. Уже загруженное (sent) второй раз не грузится
async function deliver(job, ctx) {
  try {
    if (job.voice) for (const p of job.list) if (!p.text && p.blob) await transcribe(p);
    const lengths = job.list.map((p) => p.to - p.speech);
    const frames = pick(job.frames, lengths);
    if (!frames.length && !job.list.length) { await forget(job.id); throw new Error("в записи нет ни голоса, ни кадров"); }
    const sent = (job.sent = job.sent || { metas: [], audio: null, audioDone: false });
    for (const [i, f] of frames.entries()) {
      if (sent.metas[i]) continue;
      const up = await again(async () => hubRef.post("/api/upload", { name: `screen-${clock(f.t).replace(":", "-")}.jpg`,
        mime: "image/jpeg", data: await base64(f.blob) }), (x) => x?.data?.path);
      sent.metas[i] = { ...up.data, label: `Image #${i + 1}` };
      await saveMeta(job);
    }
    // всё расшифровалось — звук не нужен; запись оборвалась (страницу обновили посреди неё) — конец есть только в звуке
    if (job.whole && (!job.stopped || job.list.some((p) => !p.text)) && !sent.audioDone) {
      try {
        const b = job.whole;
        const up = await again(async () => hubRef.post("/api/upload", { name: `voice-${new Date().toTimeString().slice(0, 5).replace(":", "-")}.webm`,
          mime: b.type || "audio/webm", data: await base64(b) }), (x) => x?.data?.path);
        sent.audio = up.data.path;
      } catch { /* без звука — фразы и кадры всё равно уйдут */ }
      sent.audioDone = true;
      await saveMeta(job);
    }
    const text = message({ length: job.length, phrases: job.list, frames, voice: job.voice, audio: sent.audio,
      cut: !job.stopped });
    await again(() => ctx.send(text, sent.metas), (x) => x && !x.error);
    await forget(job.id);
    pending = pending.filter((x) => x.id !== job.id);
    banner(sentSummary(job.list.length, frames.length), 4000);
    return true;
  } catch (e) {
    banner(`Не отправилось: ${e?.message || e}. Запись осталась в браузере — отправлю снова, когда откроете этот чат`, 15000);
    if (!pending.some((x) => x.id === job.id)) pending.push({ ...meta(job), sent: job.sent });
    resuming.delete(job.id);
    return false;
  }
}

// хаб перезапускается — повторы до ~5 минут; ошибку живого хаба от перезапуска не отличить — тоже повтор
const WAITS = [0, 1, 2, 3, 5, 5, 10, 10, 15, 15, 30, 30, 30, 30, 30, 30, 30];
async function again(fn, ok) {
  let last = null;
  for (const wait of WAITS) {
    if (wait) { banner(`Хаб не отвечает — повторю через ${wait} с. Запись сохранена в браузере`); await sleep(wait * 1000); }
    try {
      const res = await fn();
      if (ok(res)) { if (wait) banner(""); return res; }
      last = res?.error || "хаб не принял";
    } catch (e) { last = e?.message || String(e); }
  }
  throw new Error(last);
}

// недоставленная запись прошлой жизни вкладки — дослать из поля ввода её чата
async function resume(ctx) {
  const rec = pending.find((x) => x.key === ctx.key && !resuming.has(x.id));
  if (!rec || R) return;
  resuming.add(rec.id);
  R = { phase: "work", key: ctx.key, ctx };
  paintAll();
  try {
    const blobs = new Map(await blobsOf(rec.id));
    const list = rec.list.map((p, i) => ({ ...p, blob: blobs.get(`${rec.id}/p/${pad(i)}`) || null }));
    const frames = rec.frames.map((f) => ({ ...f, blob: blobs.get(`${rec.id}/f/${pad(f.n)}`) })).filter((f) => f.blob);
    const parts = [...blobs].filter(([k]) => k.startsWith(`${rec.id}/w/`)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v);
    const whole = parts.length ? new Blob(parts, { type: parts[0].type || "audio/webm" }) : null;
    banner(`Досылаю запись ${clock(rec.length)}, прерванную перезапуском`);
    await deliver({ ...rec, list, frames, whole }, ctx);
  } finally {
    R = null;
    paintAll();
  }
}

// при загрузке страницы: что осталось недоставленным
async function scan() {
  try {
    const recs = await all("rec");
    const old = recs.filter((x) => Date.now() - x.wall > 7 * 864e5);   // неделю чат не открывали — не копить
    for (const x of old) await forget(x.id);
    pending = recs.filter((x) => !old.includes(x)).sort((a, b) => a.wall - b.wall);
    if (!pending.length) return;
    banner(`Есть недоставленный видео-фидбэк (${pending.map((x) => `${clock(x.length)} → ${x.key}`).join(", ")}). `
      + "Отправлю, когда откроете этот чат", 15000);
    for (const b of buttons.values()) if (b.isConnected && b.parentNode?.__ctx) await resume(b.parentNode.__ctx);
  } catch { /* IndexedDB нет (частный режим) — запись живёт только в памяти, как раньше */ }
}

// ───── IndexedDB: rec — описание записи (фразы, кадры, что уже загружено), blob — файлы `id/p|f|w/номер` ─────
let dbP = null;
function idb() {
  dbP = dbP || new Promise((ok, bad) => {
    const q = indexedDB.open("hub-video-feedback", 1);
    q.onupgradeneeded = () => { q.result.createObjectStore("rec", { keyPath: "id" }); q.result.createObjectStore("blob"); };
    q.onsuccess = () => ok(q.result);
    q.onerror = () => bad(q.error);
  });
  return dbP;
}
async function tx(name, mode, fn) {
  const d = await idb();
  return new Promise((ok, bad) => {
    const t = d.transaction(name, mode);
    const out = fn(t.objectStore(name));
    t.oncomplete = () => ok(typeof out === "function" ? out() : out?.result);
    t.onerror = t.onabort = () => bad(t.error);
  });
}
const range = (id) => IDBKeyRange.bound(`${id}/`, `${id}/￿`);
const keep = (name, key, val) => tx(name, "readwrite", (s) => (key == null ? s.put(val) : s.put(val, key))).catch(() => {});
const all = (name) => tx(name, "readonly", (s) => s.getAll());
const blobsOf = (id) => tx("blob", "readonly", (s) => {
  const k = s.getAllKeys(range(id)), v = s.getAll(range(id));
  return () => k.result.map((x, i) => [x, v.result[i]]);
});
const forget = (id) => tx("rec", "readwrite", (s) => s.delete(id))
  .then(() => tx("blob", "readwrite", (s) => s.delete(range(id)))).catch(() => {});
const pad = (n) => String(n).padStart(4, "0");
function meta(r) {
  return { id: r.id, key: r.key, wall: r.wall, voice: !!r.voice, stopped: !!r.stopped, sent: r.sent || null,
    length: r.length ?? (r.t0 != null ? performance.now() - r.t0 : 0),
    list: r.list.map(({ from, speech, to, text }) => ({ from, speech, to, text })),
    frames: r.frames.map(({ t: at, kind, phrase, n }) => ({ t: at, kind, phrase, n })) };
}
const saveMeta = (r) => (r.id ? keep("rec", null, meta(r)) : Promise.resolve());

function release(r) {
  for (const s of [r.screen, r.mic]) s?.getTracks().forEach((t) => t.stop());
  r.audio?.close();
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const base64 = (blob) => new Promise((ok, bad) => {
  const fr = new FileReader();
  fr.onload = () => ok(String(fr.result).split(",", 2)[1] || "");
  fr.onerror = () => bad(fr.error);
  fr.readAsDataURL(blob);
});
