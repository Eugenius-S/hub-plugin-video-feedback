// Видео-фидбэк: значок рядом с микрофоном → выбор экрана → через 3 с запись экрана и голоса. Остановил — в чат уходит
// расшифровка по фразам и кадры экрана в моменты, о которых говорил (не больше 12 картинками), а все кадры — каждые
// полсекунды, безусловно, — архивом. Само видео нигде не пишется: на диск ложатся только кадры. Распознаёт голос модуль «Голос» хаба (/api/voice) — пока идёт запись.
// До подтверждения доставки фразы, кадры, звук и видео экрана лежат в IndexedDB вкладки (запись на диск — strict:
// переживает и выключение света): перезапуск хаба или обновление страницы их не теряет — отправка повторяется, после
// перезагрузки досылается сама (16.10: 3 минуты записи пропали при перезапуске хаба). Видео в хаб уходит, только если
// запись оборвалась (страницу закрыли посреди неё), — иначе удаляется вместе с записью после доставки.
import { FRAMES, MAX_MS, VOICE, bundles, clock, frameName, message, phrases, pick, sentSummary, zip } from "./lib.js";

const COUNT = 3;
// кадров по два в секунду, 10 минут — 1200 штук: JPEG сжат так, чтобы текст на экране читался, а архив не раздувался
const EDGE = 1280, PIXELS = 0.95e6, QUALITY = 0.6;
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
      let b = root.__btn;
      if (!b) {
        b = hub.el("button", "btn round quiet vf-btn");
        b.type = "button";
        b.addEventListener("click", () => (R ? (R.key === root.__ctx.key ? stop() : null) : start(root.__ctx, snap)));
        // корзина — пока идёт запись: наговорил не то — удалить, агенту ничего не уходит (владелец 16.10)
        b.__trash = hub.el("button", "btn round quiet vf-trash");
        b.__trash.type = "button";
        b.__trash.title = "Удалить запись, не отправлять";
        b.__trash.setAttribute("aria-label", b.__trash.title);
        b.__trash.append(bin());
        b.__trash.addEventListener("click", () => { if (R && R.key === root.__ctx.key) discard(); });
        root.append(b.__trash, b);
        root.__btn = b;
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
  if (b.__trash) b.__trash.hidden = !(mine && (phase === "rec" || phase === "count"));
}

function paintAll() {
  // страница хаба не обновляется сама, пока стоит эта метка: запись идёт или ещё не доставлена
  document.documentElement.toggleAttribute("data-hub-hold", !!R && R.phase !== "count");
  for (const [key, b] of buttons) if (b.isConnected) paint(b, key); else buttons.delete(key);
}

function bin() {
  const ns = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(ns, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("class", "icon");
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "1.8");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  p.setAttribute("d", "M4 7h16M10 11v6M14 11v6M5.5 7l1 12a2 2 0 0 0 2 1.8h7a2 2 0 0 0 2-1.8l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2");
  s.append(p);
  return s;
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
  r.videoN = 0;
  r.io = Promise.resolve();
  r.list = [];          // фразы: {from, speech, to, text}
  r.frames = [];        // кадры: {t, kind, phrase, blob, n}
  r.jobs = Promise.resolve();
  r.grab = grabber(r.screen.getVideoTracks()[0]);
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
    r.whole = piece(r.mic, (b) => put(r, `${r.id}/w/${pad(r.wholeN++)}`, b), 5000);
  }
  // видео экрана — только в IndexedDB, не в памяти: дойдёт до хаба, если запись оборвётся (владелец 16.10)
  try { r.video = piece(r.screen, (b) => put(r, `${r.id}/v/${pad(r.videoN++)}`, b), 5000, VIDEO); }
  catch { r.video = null; }   // браузер не пишет видео — кадры и звук всё равно сохранятся
  saveMeta(r);
  // таймер — в отдельном потоке: вкладка хаба во время записи обычно не на виду, и её таймеры браузер притормаживает
  r.worker = new Worker(hubRef.url("tick.js"));
  r.worker.onmessage = () => tick(r);
  r.worker.postMessage(TICK);
  paintAll();
}

// кусок голоса: MediaRecorder идёт непрерывно, режется в паузах (VOICE). Видео (VIDEO) — тот же запис, но куски только
// отдаются onChunk (в IndexedDB) и в памяти не копятся; битрейт — чтобы 10 минут экрана влезли в одно вложение (20 МБ)
const AUDIO = { kinds: ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"], type: "audio/webm" };
const VIDEO = { kinds: ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"], type: "video/webm",
  opts: { videoBitsPerSecond: 250e3 }, memory: false };
function piece(stream, onChunk, slice, kind = AUDIO) {
  const mime = kind.kinds.find((m) => MediaRecorder.isTypeSupported(m)) || "";
  const chunks = [];
  const rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), ...(kind.opts || {}) });
  const done = new Promise((ok) => { rec.onstop = () => ok(new Blob(chunks, { type: rec.mimeType || kind.type })); });
  rec.ondataavailable = (e) => { if (e.data.size) { if (kind.memory !== false) chunks.push(e.data); onChunk?.(e.data); } };
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
  if (r.ticks % (FRAMES.every / TICK) === 0 && !r.busyShot) {   // каждые полсекунды — кадр, даже если экран не менялся
    r.busyShot = true;
    try { await shoot(r, t, "tick"); } finally { r.busyShot = false; }
  }
}

// фраза закончилась: распознать её сейчас же, пока идёт запись (к остановке почти всё уже готово)
function hear(r, cut, blob) {
  const p = { ...cut, text: "", blob };
  const i = r.list.push(p) - 1;
  blob.then((b) => { p.blob = b; return put(r, `${r.id}/p/${pad(i)}`, b); }).then(() => saveMeta(r));
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
    const blob = await r.grab();
    if (!blob) return;
    const n = r.frameN++;
    r.frames.push({ t, kind, phrase, blob, n });
    put(r, `${r.id}/f/${pad(n)}`, blob);   // описание кадров — saveMeta раз в 5 с и при остановке, не 2 раза в секунду
  } catch { /* без этого кадра */ }
}

// снимок экрана: JPEG с длинной стороной до EDGE
function grabber(track) {
  const cap = "ImageCapture" in window ? new ImageCapture(track) : null;
  let video = null;
  return async () => {
    let src;
    if (cap) src = await cap.grabFrame();
    else {
      if (!video) { video = document.createElement("video"); video.muted = true; video.srcObject = new MediaStream([track]); await video.play(); }
      src = video;
    }
    const w = src.width || src.videoWidth, h = src.height || src.videoHeight;
    if (!w || !h) return null;
    const k = Math.min(1, EDGE / Math.max(w, h), Math.sqrt(PIXELS / (w * h)));
    const c = document.createElement("canvas");
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    src.close?.();
    return new Promise((ok) => c.toBlob(ok, "image/jpeg", QUALITY));
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
  const video = r.video?.stop();
  release(r);
  try {
    await r.jobs;
    await video;
    r.length = length;
    r.stopped = true;
    await r.io;
    await saveMeta(r);
    await deliver({ ...meta(r), list: r.list, frames: r.frames, whole: whole ? await whole : null }, r.ctx);
  } finally {
    R = null;
    paintAll();
  }
}

// корзина: остановить и стереть — ни в хаб, ни в браузере ничего не остаётся
async function discard() {
  const r = R;
  if (!r) return;
  if (r.phase === "count") return stop();   // отсчёт ещё идёт — то же, что отмена
  if (r.phase !== "rec") return;
  r.phase = "gone";
  r.dead = true;   // запоздалые куски и описание записи в IndexedDB больше не пишутся
  r.worker.terminate();
  document.title = r.title;
  const stops = [r.piece?.stop(), r.whole?.stop(), r.video?.stop()];
  release(r);
  R = null;
  paintAll();
  await Promise.all(stops);
  await r.io;
  await forget(r.id);
  banner("Запись удалена, агенту ничего не ушло", 4000);
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
    // кадров больше, чем ушло картинками, — все архивом (zip, части до 18 МБ): сессия распакует, разберёт и удалит
    if (job.frames.length > frames.length && !sent.archiveDone) {
      sent.archive = sent.archive || [];
      const seen = new Set();
      const all = [...job.frames].sort((a, b) => a.t - b.t).map((f) => ({ f, name: frameName(f.t, seen), size: f.blob.size }));
      const groups = bundles(all, FRAMES.part);
      try {
        for (let i = sent.archive.length; i < groups.length; i++) {
          const files = await Promise.all(groups[i].map(async (x) => ({ name: x.name, data: new Uint8Array(await x.f.blob.arrayBuffer()) })));
          const b = new Blob([zip(files)], { type: "application/zip" });
          const n = groups.length;
          const up = await again(async () => hubRef.post("/api/upload", { name: `frames${n > 1 ? `-${i + 1}of${n}` : ""}.zip`,
            mime: "application/zip", data: await base64(b) }), (x) => x?.data?.path);
          sent.archive.push(up.data.path);
          await saveMeta(job);
        }
      } catch { /* без архива — картинки выше и фразы всё равно уйдут */ }
      sent.archiveDone = true;
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
    // оборванная запись — и видео экрана, частями до 18 МБ (вложение — до 20 МБ); части склеиваются байт в байт
    if (!job.stopped && job.video && !sent.videoDone) {
      sent.video = sent.video || [];
      const PART = 18 * 1024 * 1024;
      const n = Math.ceil(job.video.size / PART);
      try {
        for (let i = sent.video.length; i < n; i++) {
          const b = job.video.slice(i * PART, (i + 1) * PART);
          const up = await again(async () => hubRef.post("/api/upload", { name: `screen-video${n > 1 ? `-${i + 1}of${n}` : ""}.webm`,
            mime: "video/webm", data: await base64(b) }), (x) => x?.data?.path);
          sent.video.push(up.data.path);
          await saveMeta(job);
        }
      } catch { /* без видео — кадры и звук всё равно уйдут */ }
      sent.videoDone = true;
      await saveMeta(job);
    }
    const text = message({ length: job.length, phrases: job.list, frames, voice: job.voice, audio: sent.audio,
      cut: !job.stopped, video: sent.video || null,
      archive: sent.archive?.length ? { paths: sent.archive, count: job.frames.length } : null });
    await again(() => ctx.send(text, sent.metas), (x) => x && !x.error);
    await forget(job.id);
    pending = pending.filter((x) => x.id !== job.id);
    banner(sentSummary(job.list.length, sent.archive?.length ? job.frames.length : frames.length), 4000);
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
    const vparts = [...blobs].filter(([k]) => k.startsWith(`${rec.id}/v/`)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v);
    const video = vparts.length ? new Blob(vparts, { type: vparts[0].type || "video/webm" }) : null;
    banner(`Досылаю запись ${clock(rec.length)}, прерванную перезапуском`);
    await deliver({ ...rec, list, frames, whole, video }, ctx);
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
    const live = new Set(pending.map((x) => x.id));   // куски без записи (удалили корзиной, не дописалось) — стереть
    const orphans = new Set((await tx("blob", "readonly", (st) => st.getAllKeys())).map((k) => String(k).split("/")[0]).filter((id) => !live.has(id)));
    for (const id of orphans) await forget(id);
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
    // запись — strict: на диске, когда транзакция кончилась (иначе браузер может не успеть до выключения света)
    const t = mode === "readwrite" ? d.transaction(name, mode, { durability: "strict" }) : d.transaction(name, mode);
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
// кусок идущей записи — по очереди (корзина ждёт, пока допишется), стёртой — уже не пишется
const put = (r, key, val) => (r.io = r.io.then(() => (r.dead ? null : keep("blob", key, val))));
function meta(r) {
  return { id: r.id, key: r.key, wall: r.wall, voice: !!r.voice, stopped: !!r.stopped, sent: r.sent || null,
    length: r.length ?? (r.t0 != null ? performance.now() - r.t0 : 0),
    list: r.list.map(({ from, speech, to, text }) => ({ from, speech, to, text })),
    frames: r.frames.map(({ t: at, kind, phrase, n }) => ({ t: at, kind, phrase, n })) };
}
const saveMeta = (r) => (r.id && !r.dead ? keep("rec", null, meta(r)) : Promise.resolve());

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
