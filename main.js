// Видео-фидбэк: значок рядом с микрофоном → выбор экрана → через 3 с запись экрана и голоса. Остановил — в чат уходит
// расшифровка по фразам и кадры экрана в моменты, о которых говорил. Само видео нигде не пишется: на диск ложатся
// только эти кадры, как вставленные картинки. Распознаёт голос модуль «Голос» хаба (/api/voice) — пока идёт запись.
import { FRAMES, MAX_MS, VOICE, changed, clock, diff, message, phrases, pick } from "./lib.js";

const COUNT = 3;
const EDGE = 1568, PIXELS = 1.15e6;   // больше этого модель кадр всё равно уменьшит: лишнее — только вес файла
const TICK = 250;

let R = null;          // идущая запись: {phase: "count" | "rec" | "work", key, ...}
const buttons = new Map();   // ключ поля → кнопка
let hubRef = null;

globalThis.__videoFeedback = () => R;   // для проверки в песочнице: идущая запись

export default function register(hub) {
  if (!navigator.mediaDevices?.getDisplayMedia) return;   // телефон: записи экрана нет — и значка нет
  hubRef = hub;
  hub.addStyle("style.css");
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
    idle: "Видео-фидбэк: запись экрана с голосом. Выберите экран — запись начнётся через 3 секунды",
    busy: "Идёт запись в другом поле",
    count: `Запись через ${R?.left}`,
    rec: "Остановить и отправить",
    work: "Расшифровываю и отправляю",
  }[phase];
  b.title = say;
  b.setAttribute("aria-label", say);
}

function paintAll() { for (const [key, b] of buttons) if (b.isConnected) paint(b, key); else buttons.delete(key); }

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
    if (e?.name !== "NotAllowedError") banner(`Запись экрана не включилась: ${e?.message || e}`, 8000);
    return;   // отменили выбор экрана — ничего не было
  }
  try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch { banner("Микрофон не дали — запишу только экран", 5000); }
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
  }
  // таймер — в отдельном потоке: вкладка хаба во время записи обычно не на виду, и её таймеры браузер притормаживает
  r.worker = new Worker(hubRef.url("tick.js"));
  r.worker.onmessage = () => tick(r);
  r.worker.postMessage(TICK);
  paintAll();
}

// кусок голоса: MediaRecorder идёт непрерывно, режется в паузах (VOICE)
function piece(stream) {
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
  const chunks = [];
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
  const done = new Promise((ok) => { rec.onstop = () => ok(new Blob(chunks, { type: rec.mimeType || "audio/webm" })); });
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start();
  return { stop: () => { if (rec.state !== "inactive") rec.stop(); return done; } };
}

async function tick(r) {
  if (R !== r || r.phase !== "rec") return;
  const t = performance.now() - r.t0;
  if (t >= MAX_MS) return stop();
  r.ticks++;
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
  const p = { ...cut, text: "" };
  r.list.push(p);
  if (!r.voice) return;
  r.jobs = r.jobs.then(async () => {
    try {
      const b = await blob;
      const res = await hubRef.post("/api/voice", { data: await base64(b), mime: b.type });
      p.text = String(res?.data?.text || "").trim();
    } catch { /* не разобрал — в сообщении так и будет */ }
  });
}

async function shoot(r, t, kind) {
  const phrase = r.list.length;   // фраза, что идёт сейчас
  try {
    const { sig, blob } = await r.grab(true);
    if (r.keptSig && diff(sig, r.keptSig) < FRAMES.same) return;   // тот же экран — второй кадр не нужен
    r.keptSig = sig;
    r.frames.push({ t, kind, phrase, blob });
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
  if (r.an) {
    const last = r.voiceCut.finish(length);
    const blob = r.piece.stop();
    if (last) hear(r, last, blob);
  }
  release(r);
  try {
    await r.jobs;
    const lengths = r.list.map((p) => p.to - p.speech);
    const frames = pick(r.frames, lengths);
    if (!frames.length && !r.list.length) throw new Error("в записи ни голоса, ни кадров");
    const metas = [];
    for (const [i, f] of frames.entries()) {
      const up = await hubRef.post("/api/upload", { name: `screen-${clock(f.t).replace(":", "-")}.jpg`, mime: "image/jpeg",
        data: await base64(f.blob) });
      const meta = up?.data;
      if (!meta?.path) throw new Error(up?.error || "кадр не загрузился");
      metas.push({ ...meta, label: `Image #${i + 1}` });
    }
    const text = message({ length, phrases: r.list, frames, voice: r.voice });
    const res = await r.ctx.send(text, metas);
    if (res?.error) throw new Error(res.error);
    banner(`Видео-фидбэк ушёл: ${r.list.length} фраз, ${frames.length} кадров`, 4000);
  } catch (e) {
    banner(`Видео-фидбэк не ушёл: ${e?.message || e}`, 12000);
  } finally {
    R = null;
    paintAll();
  }
}

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
