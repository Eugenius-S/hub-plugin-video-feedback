// Video feedback: an icon next to the microphone -> pick a screen -> after 3 s the screen and voice are recorded. On stop,
// the chat gets the transcript by phrases and screen frames at the moments that were talked about (at most 12 as pictures),
// all frames - every half second, unconditionally - as an archive, and the screen video itself as a file (in parts up to
// 18 MB). The voice is recognized by the hub's Voice module (/api/voice) while the recording runs.
// Until delivery is confirmed, phrases, frames, audio and the screen video sit in the tab's IndexedDB (written to disk with
// strict durability: survives even a power cut): a hub restart or a page reload does not lose them - sending is retried and,
// after a reload, finishes by itself (Oct 16: 3 minutes of recording were lost on a hub restart). The video always goes to
// the hub - after a normal stop and for an interrupted recording alike (Oct 19: 0.3-0.5 sent it only on interruption, and
// the text said "The video was not saved"); it is erased from the browser after the hub accepted the message.
// UI texts and the message to the session: en by default, ru when the hub language is Russian (strings.js, picked by
// hub.lang at use time).
import { FRAMES, MAX_MS, VOICE, bundles, clock, frameName, message, phrases, pick, sentSummary, stamp, zip } from "./lib.js";
import { createIsland, icon } from "./island.js";
import { tr } from "./strings.js";

const COUNT = 3;
// Motion Gallery (a separate plugin) serves its catalog on the hub port + 12; it is asked only from a local page
const MG_PORT = 12, MG_WAIT = 2500;
const TAG_SHOT = 200;   // a frame this long after a tag is picked: the pick has closed the popover by then
// two frames a second, 10 minutes - 1200 of them: JPEG is compressed so that screen text stays readable and the archive does not bloat
const EDGE = 1280, PIXELS = 0.95e6, QUALITY = 0.6;
const TICK = 250;
const VIDEO_PART = 18 * 1024 * 1024;   // a video part in one upload
const VIDEO_TRIES = 3;                 // visits with a hub refusal after which the message goes without the video
// phrases transcribed at once. A local whisper may load its model on every call (~20-30 s a phrase): one at a time, a
// 6-minute recording of 60 phrases waited 10 minutes after the stop with a bare spinner, and the owner took it for lost (Oct 21)
const VOICE_JOBS = 2;

let R = null;          // the running recording: {phase: "count" | "rec" | "work", key, ...}
const buttons = new Map();   // input field key -> button
let hubRef = null;
let pending = [];      // undelivered recordings from IndexedDB (a past life of the tab) - the input field of their chat sends them
const resuming = new Set();
// hubRef.lang is read on every call, never at module load
const lang = () => hubRef?.lang;
const t = (key, vars) => tr(lang(), key, vars);

globalThis.__videoFeedback = () => R;   // for checks in a sandbox: the running recording

export default function register(hub) {
  if (!navigator.mediaDevices?.getDisplayMedia) return;   // a phone: no screen recording, so no icon
  hubRef = hub;
  hub.addStyle("style.css");
  // during a recording or sending, leaving the page asks (and an update to a new hub version waits on the data-hub-hold mark)
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
        // the bin is there while recording: said the wrong thing - delete it, nothing goes to the agent
        b.__trash = hub.el("button", "btn round quiet vf-trash");
        b.__trash.type = "button";
        b.__trash.title = t("trash");
        b.__trash.setAttribute("aria-label", b.__trash.title);
        b.__trash.append(bin());
        b.__trash.addEventListener("click", () => { if (R && R.key === root.__ctx.key) discard(); });
        // the pen: brings the drawing island back after it was closed (it opens by itself when the recording starts)
        b.__pen = hub.el("button", "btn round quiet vf-pen");
        b.__pen.type = "button";
        b.__pen.hidden = true;
        b.__pen.append(pen());
        b.__pen.addEventListener("click", () => { if (R && R.key === root.__ctx.key) R.island?.open(); });
        root.append(b.__pen, b.__trash, b);
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
  const penned = mine && phase === "rec" && !!R.island && !R.island.isOpen();   // the island is closed: the pen button brings it back
  const sig = phase + (phase === "count" ? R.left : phase === "rec" ? clock(performance.now() - R.t0) : "") + (lang() || "") + (penned ? "p" : "");
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
    idle: t("say_idle"),
    busy: t("say_busy"),
    count: t("say_count", { n: R?.left }),
    rec: t("say_rec"),
    work: t("say_work"),
  }[phase];
  b.title = say;
  b.setAttribute("aria-label", say);
  if (b.__trash) b.__trash.hidden = !(mine && (phase === "rec" || phase === "count"));
  if (b.__pen) {
    b.__pen.hidden = !penned;
    b.__pen.title = t("draw_open");
    b.__pen.setAttribute("aria-label", b.__pen.title);
  }
}

function paintAll() {
  // the hub page does not reload by itself while this mark stands: a recording is running or not delivered yet
  document.documentElement.toggleAttribute("data-hub-hold", !!R && R.phase !== "count");
  for (const [key, b] of buttons) if (b.isConnected) paint(b, key); else buttons.delete(key);
  // the island's stop button shows the same time as the hub's record button
  R?.island?.recording(R.phase === "rec" ? clock(performance.now() - R.t0) : null);
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

function pen() {
  const s = icon("pencil");
  s.setAttribute("class", "icon");
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

// a caption over the page: the countdown and errors (the hub tab may be out of sight - the same goes for the button)
// In full screen only the fullscreen element and what is inside it is shown, so the caption goes inside it (video, iframe and the
// like cannot hold it: those stay under the page, the island floats out there anyway)
const bannerHost = () => {
  const fe = document.fullscreenElement;
  return fe && fe !== document.documentElement && !/^(video|audio|iframe|embed|object|img|canvas|input|textarea|select|br|hr)$/.test(fe.localName) ? fe : document.body;
};
function bannerPut(n) {
  const h = bannerHost();
  if (n.parentNode !== h) h.append(n);
  n.classList.toggle("vf-banner-fs", h !== document.body);
}
document.addEventListener("fullscreenchange", () => { const n = document.querySelector(".vf-banner"); if (n) bannerPut(n); });
function banner(text, ms) {
  let n = document.querySelector(".vf-banner");
  if (!text) return n?.remove();
  if (!n) { n = hubRef.el("div", "vf-banner"); n.setAttribute("role", "status"); }
  bannerPut(n);
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
    if (e?.name !== "NotAllowedError") banner(t("screen_failed", { err: e?.message || e }), 8000);
    return;   // the screen pick was cancelled: nothing happened
  }
  try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch { banner(t("no_mic"), 5000); }
  R = { phase: "count", left: COUNT, key: ctx.key, ctx, screen, mic, voice: !!snap?.voice, cancelled: false };
  const track = screen.getVideoTracks()[0];
  track.addEventListener("ended", () => stop());   // "Stop sharing" in the browser bar
  const r = R;
  r.confined = await confine(track, r);
  for (; r.left > 0; r.left--) {
    banner(t("say_count", { n: r.left }));
    paintAll();
    await sleep(1000);
    if (r.cancelled) return;
  }
  banner("");
  record();
}

// Leave the pen island out of the recording. Element Capture crops the stream of a browser TAB to <body>; the island is a child
// of <html>, outside <body>, so it is on screen but not in the video and not in the frames (the strokes live on a canvas
// inside <body> and are recorded). It works only when the picked surface is a tab (Chrome 132+): a whole screen or a window
// has no such mechanism, there the island is recorded together with everything else. Returns whether the crop took hold.
// The isolated body needs a picture under the strokes (a transparent body can be cropped to black), and the page colour usually
// belongs to the viewport (it moves there from <html> or <body>), so while the crop holds, both paint the same opaque colour.
const clear = (c) => !c || c === "transparent" || /^rgba?\(.*,\s*0\)$|^rgb\(.*\/\s*0\)$/.test(c);
async function confine(track, r) {
  const body = document.body.style, html = document.documentElement.style;
  const was = { iso: body.isolation, body: body.backgroundColor, html: html.backgroundColor };
  const undo = () => { body.isolation = was.iso; body.backgroundColor = was.body; html.backgroundColor = was.html; };
  try {
    if (track.getSettings?.().displaySurface !== "browser") return false;
    const RT = globalThis.RestrictionTarget;
    if (!RT?.fromElement || !track.restrictTo) return false;
    const paint = [document.body, document.documentElement].map((e) => getComputedStyle(e).backgroundColor).find((c) => !clear(c)) || "Canvas";
    // Element Capture needs the element to be its own stacking context, otherwise the track can stay blank
    body.isolation = "isolate";
    body.backgroundColor = html.backgroundColor = paint;
    r.unconfine = undo;   // registered before the await: a stop during the countdown must still put the page back
    await track.restrictTo(await RT.fromElement(document.body));
    return true;
  } catch { undo(); r.unconfine = null; return false; }   // an older browser, or the body does not cover the tab: not an error, the island is just visible in the video
}

// the Motion Gallery catalog: {items, base} or null when that plugin is not installed or not running (nothing to show then)
async function gallery() {
  const { protocol, hostname, port } = location;
  if (hostname !== "localhost" && hostname !== "127.0.0.1") return null;
  const base = `${protocol}//${hostname}:${Number(port || 8787) + MG_PORT}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), MG_WAIT);
  try {
    const res = await fetch(`${base}/gallery.json`, { signal: ctl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const items = (Array.isArray(data?.items) ? data.items : []).filter((x) => x && typeof x.slug === "string" && x.slug);
    return items.length ? { items, base } : null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

// a tag: the owner pointed at an animation for this moment of the video. Besides the line in the message, a frame is taken
// right after (the popover has closed by then) and linked to the tag, so the session sees what was on the screen
function tag(r, item) {
  if (R !== r || r.phase !== "rec") return -1;
  const at = performance.now() - r.t0;
  const index = r.tags.push({ slug: item.slug, title: String(item.title || item.slug), t: at }) - 1;
  setTimeout(() => { if (R === r && r.phase === "rec" && r.tags[index]) shoot(r, performance.now() - r.t0, "tag", { tag: index }); }, TAG_SHOT);
  saveMeta(r);
  return index;
}
function untag(r, index) {
  const x = r.tags[index];
  if (!x) return;
  x.gone = true;   // the index stays: frames already linked to it, the list is never shifted
  r.frames = r.frames.filter((f) => f.tag !== index);
  saveMeta(r);
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
  r.list = [];          // phrases: {from, speech, to, text}
  r.frames = [];        // frames: {t, kind, phrase, blob, n}
  r.waiting = [];       // phrases waiting for transcription
  r.running = 0;
  r.grab = grabber(r.screen.getVideoTracks()[0], hubRef.url("frame.js"));
  r.ticks = 0;
  r.title = document.title;
  r.tags = [];          // animation tags: {slug, title, t, gone?}
  r.drew = false;
  r.island = createIsland({
    el: hubRef.el, t,
    timecode: () => stamp(performance.now() - r.t0), gallery,
    onTag: (item) => tag(r, item), onUntag: (i) => untag(r, i), onStroke: () => { r.drew = true; saveMeta(r); },
    onToggle: () => paintAll(), onStop: () => stop(), onDiscard: () => discard(),
  });
  r.island.open();
  // a whole screen or a window: the island on the page would be covered by other programs, so it floats out into its own window
  const surface = r.screen.getVideoTracks()[0].getSettings?.().displaySurface;
  if (surface === "monitor" || surface === "window") r.island.floatForScreen((el) => [...buttons.values()].some((b) => b.contains(el)));
  if (r.mic) {
    r.audio = new AudioContext();
    r.an = r.audio.createAnalyser();
    r.an.fftSize = 2048;
    r.audio.createMediaStreamSource(r.mic).connect(r.an);
    r.buf = new Float32Array(r.an.fftSize);
    r.voiceCut = phrases(VOICE);
    r.voiceCut.begin(0);
    r.piece = piece(r.mic);
    // all the audio as one file: if the phrases have no text it goes to the hub before transcription; in 5 s pieces to IndexedDB
    r.whole = piece(r.mic, (b) => put(r, `${r.id}/w/${pad(r.wholeN++)}`, b), 5000);
  }
  // the screen video goes only to IndexedDB, not memory: it reaches the hub even if the recording is cut off
  try { r.video = piece(r.screen, (b) => put(r, `${r.id}/v/${pad(r.videoN++)}`, b), 5000, VIDEO); }
  catch { r.video = null; }   // the browser cannot record video - frames and audio are saved anyway
  saveMeta(r);
  // the timer lives in a separate thread: the hub tab is usually out of sight during a recording and the browser throttles its timers
  r.worker = new Worker(hubRef.url("tick.js"));
  r.worker.onmessage = () => tick(r);
  r.worker.postMessage(TICK);
  paintAll();
}

// a piece of voice: MediaRecorder runs continuously and is cut in pauses (VOICE). Video (VIDEO) is the same recorder, its
// chunks also go straight to IndexedDB (onChunk); the bitrate is chosen so that 10 minutes of screen are about 19 MB
const AUDIO = { kinds: ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"], type: "audio/webm" };
const VIDEO = { kinds: ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"], type: "video/webm",
  opts: { videoBitsPerSecond: 250e3 } };
function piece(stream, onChunk, slice, kind = AUDIO) {
  const mime = kind.kinds.find((m) => MediaRecorder.isTypeSupported(m)) || "";
  const chunks = [];
  const rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), ...(kind.opts || {}) });
  const done = new Promise((ok) => { rec.onstop = () => ok(new Blob(chunks, { type: rec.mimeType || kind.type })); });
  rec.ondataavailable = (e) => { if (e.data.size) { chunks.push(e.data); onChunk?.(e.data); } };
  rec.start(slice);
  return { stop: () => { if (rec.state !== "inactive") rec.stop(); return done; } };
}

async function tick(r) {
  if (R !== r || r.phase !== "rec") return;
  const t = performance.now() - r.t0;
  if (t >= MAX_MS) return stop();
  r.ticks++;
  if (r.ticks % 20 === 0) saveMeta(r);   // the length, in case the tab is reloaded in the middle of a recording
  if (r.ticks % 4 === 0) {
    paintAll();
    document.title = tr(lang(), "tab_title", { time: clock(t) });
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
      r.piece = piece(r.mic);   // the next piece is recorded at once - nothing is lost in the pause
      const blob = old.stop();
      if (step.cut) hear(r, step.cut, blob);
    }
  }
  if (r.ticks % (FRAMES.every / TICK) === 0 && !r.busyShot) {   // a frame every half second, even if the screen did not change
    r.busyShot = true;
    try { await shoot(r, t, "tick"); } finally { r.busyShot = false; }
  }
}

// a phrase is over: recognize it right now, while the recording runs (by the stop almost everything is ready)
function hear(r, cut, blob) {
  const p = { ...cut, text: "", blob };
  const i = r.list.push(p) - 1;
  blob.then((b) => { p.blob = b; return put(r, `${r.id}/p/${pad(i)}`, b); }).then(() => saveMeta(r));
  if (!r.voice) return;
  r.waiting.push(p);
  pump(r);
}

// the transcription queue: up to VOICE_JOBS phrases at once, in the order they were said
function pump(r) {
  while (r.running < VOICE_JOBS && r.waiting.length) {
    const p = r.waiting.shift();
    r.running++;
    transcribe(p).then(() => {
      r.running--;
      saveMeta(r);
      progress(r);
      pump(r);
      if (!r.running && !r.waiting.length) r.onDrain?.();
    });
  }
}
const drained = (r) => new Promise((ok) => {
  const check = () => (!r.running && !r.waiting.length ? ok() : (r.onDrain = check));
  check();
});

// after the stop the transcription may take minutes: say how far it is, on the page and in the tab title (the tab is
// usually out of sight), so a long wait does not look like a lost recording
function progress(r) {
  if (R !== r || r.phase !== "work" || !r.voice) return;
  const all = r.list.length, done = r.list.filter((p) => p.heard).length;
  if (done >= all) return;
  banner(t("transcribing", { done, all }));
  document.title = t("tab_work", { done, all });
}

// phrase -> text; the hub did not answer (restart): once more at sending
async function transcribe(p) {
  try {
    const b = await p.blob;
    const res = await hubRef.post("/api/voice", { data: await base64(b), mime: b.type });
    p.text = String(res?.data?.text || "").trim();
  } catch { /* not recognized - the message will say so */ }
  p.heard = true;
}

async function shoot(r, t, kind, extra) {
  const phrase = r.list.length;   // the phrase going on now
  try {
    const blob = await r.grab();
    if (!blob) return;
    const n = r.frameN++;
    r.frames.push({ t, kind, phrase, blob, n, ...extra });
    put(r, `${r.id}/f/${pad(n)}`, blob);   // the frame list goes with saveMeta once per 5 s and at stop, not twice a second
  } catch { /* no such frame */ }
}

// a screen shot: JPEG with the long side up to EDGE. The page only takes the frame (ImageCapture, or a bitmap of the video);
// scaling and encoding go to a worker, so the pen and the island on the page keep their frame rate. No worker: the same on the page.
function grabber(track, workerUrl) {
  const cap = "ImageCapture" in window ? new ImageCapture(track) : null;
  let video = null, worker = null, n = 0;
  const wait = new Map();
  const end = () => { for (const ok of wait.values()) ok(null); wait.clear(); };
  try {
    if (typeof OffscreenCanvas !== "undefined") {
      worker = new Worker(workerUrl);
      worker.onmessage = (e) => { wait.get(e.data.id)?.(e.data.blob); wait.delete(e.data.id); };
      worker.onerror = () => { worker?.terminate(); worker = null; end(); };
    }
  } catch { worker = null; }
  const grab = async () => {
    let src;
    if (cap) src = await cap.grabFrame();
    else {
      if (!video) { video = document.createElement("video"); video.muted = true; video.srcObject = new MediaStream([track]); await video.play(); }
      src = await createImageBitmap(video);
    }
    const w = src.width, h = src.height;
    if (!w || !h) { src.close?.(); return null; }
    const k = Math.min(1, EDGE / Math.max(w, h), Math.sqrt(PIXELS / (w * h)));
    const cw = Math.round(w * k), ch = Math.round(h * k);
    if (worker) {
      const id = ++n;
      const done = new Promise((ok) => wait.set(id, ok));
      worker.postMessage({ id, bitmap: src, w: cw, h: ch, quality: QUALITY }, [src]);
      return done;
    }
    const c = document.createElement("canvas");
    c.width = cw; c.height = ch;
    c.getContext("2d").drawImage(src, 0, 0, cw, ch);
    src.close?.();
    return new Promise((ok) => c.toBlob(ok, "image/jpeg", QUALITY));
  };
  grab.close = () => { worker?.terminate(); worker = null; end(); };
  return grab;
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
    progress(r);
    await drained(r);
    banner(t("sending"));
    r.length = length;
    r.stopped = true;
    const screen = video ? await video : null;   // the whole screen video (the chunks are also in IndexedDB, in case sending breaks off)
    await r.io;
    await saveMeta(r);
    await deliver({ ...meta(r), list: r.list, frames: r.frames, whole: whole ? await whole : null,
      video: screen?.size ? screen : null }, r.ctx);
  } finally {
    document.title = r.title;
    R = null;
    paintAll();
  }
}

// the bin: stop and erase - nothing is left in the hub or in the browser
async function discard() {
  const r = R;
  if (!r) return;
  if (r.phase === "count") return stop();   // the countdown is still on: same as cancel
  if (r.phase !== "rec") return;
  r.phase = "gone";
  r.dead = true;   // late chunks and the recording description are no longer written to IndexedDB
  r.worker.terminate();
  document.title = r.title;
  const stops = [r.piece?.stop(), r.whole?.stop(), r.video?.stop()];
  release(r);
  R = null;
  paintAll();
  await Promise.all(stops);
  await r.io;
  await forget(r.id);
  banner(t("discarded"), 4000);
}

// delivery: frames, audio (if the phrases have no text), the message. The hub did not answer (restart): retry; the recording
// leaves IndexedDB only after the hub accepted the message. What is already uploaded (sent) is not uploaded again
async function deliver(job, ctx) {
  try {
    if (job.voice) {
      const left = job.list.filter((p) => !p.text && p.blob);
      for (const [i, p] of left.entries()) {
        banner(t("transcribing", { done: i, all: left.length }));
        await transcribe(p);
      }
      if (left.length) banner(t("sending"));
    }
    const lengths = job.list.map((p) => p.to - p.speech);
    const frames = pick(job.frames, lengths);
    if (!frames.length && !job.list.length) { await forget(job.id); throw new Error(t("empty_rec")); }
    const sent = (job.sent = job.sent || { metas: [], audio: null, audioDone: false });
    for (const [i, f] of frames.entries()) {
      if (sent.metas[i]) continue;
      const up = await again(async () => hubRef.post("/api/upload", { name: `screen-${clock(f.t).replace(":", "-")}.jpg`,
        mime: "image/jpeg", data: await base64(f.blob) }), (x) => x?.data?.path);
      sent.metas[i] = { ...up.data, label: `Image #${i + 1}` };
      await saveMeta(job);
    }
    // more frames than went as pictures: all of them as an archive (zip, parts up to 18 MB): the session unpacks, reviews and deletes it
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
      } catch { /* no archive - the pictures above and the phrases go anyway */ }
      sent.archiveDone = true;
      await saveMeta(job);
    }
    // everything was transcribed: no audio needed; the recording was cut off (the page was reloaded in the middle): the end exists only in the audio
    if (job.whole && (!job.stopped || job.list.some((p) => !p.text)) && !sent.audioDone) {
      try {
        const b = job.whole;
        const up = await again(async () => hubRef.post("/api/upload", { name: `voice-${new Date().toTimeString().slice(0, 5).replace(":", "-")}.webm`,
          mime: b.type || "audio/webm", data: await base64(b) }), (x) => x?.data?.path);
        sent.audio = up.data.path;
      } catch { /* no audio - the phrases and frames go anyway */ }
      sent.audioDone = true;
      await saveMeta(job);
    }
    // the screen video always goes, in parts up to 18 MB (an attachment is up to 20 MB); the parts are joined byte for byte.
    // Not uploaded (the hub was down longer than the retries): the recording stays in the browser and is sent on the next
    // visit; the message goes without the video only after VIDEO_TRIES failed visits (a stubborn hub refusal must not hold
    // the feedback forever)
    if (job.video?.size && !sent.videoDone) {
      sent.video = sent.video || [];
      const n = Math.ceil(job.video.size / VIDEO_PART);
      try {
        for (let i = sent.video.length; i < n; i++) {
          const b = job.video.slice(i * VIDEO_PART, (i + 1) * VIDEO_PART);
          const up = await again(async () => hubRef.post("/api/upload", { name: `screen-video${n > 1 ? `-${i + 1}of${n}` : ""}.webm`,
            mime: "video/webm", data: await base64(b) }), (x) => x?.data?.path);
          sent.video.push(up.data.path);
          await saveMeta(job);
        }
      } catch (e) {
        sent.videoFails = (sent.videoFails || 0) + 1;
        await saveMeta(job);
        if (sent.videoFails < VIDEO_TRIES) throw new Error(t("video_failed", { err: e?.message || e }));
        sent.video = null;   // gave up: a part without the rest is not a video
      }
      sent.videoDone = true;
      await saveMeta(job);
    }
    const text = message({ length: job.length, phrases: job.list, frames, voice: job.voice, audio: sent.audio,
      cut: !job.stopped, video: sent.video || null, tags: job.tags || [], drew: !!job.drew,
      archive: sent.archive?.length ? { paths: sent.archive, count: job.frames.length } : null, lang: lang() });
    await again(() => ctx.send(text, sent.metas), (x) => x && !x.error);
    await forget(job.id);
    pending = pending.filter((x) => x.id !== job.id);
    banner(sentSummary(job.list.length, sent.archive?.length ? job.frames.length : frames.length, lang()), 4000);
    return true;
  } catch (e) {
    banner(t("not_sent", { err: e?.message || e }), 15000);
    if (!pending.some((x) => x.id === job.id)) pending.push({ ...meta(job), sent: job.sent });
    resuming.delete(job.id);
    return false;
  }
}

// the hub is restarting: retries for up to ~5 minutes; an error of a live hub cannot be told from a restart, so it is retried too
const WAITS = [0, 1, 2, 3, 5, 5, 10, 10, 15, 15, 30, 30, 30, 30, 30, 30, 30];
async function again(fn, ok) {
  let last = null;
  for (const wait of WAITS) {
    if (wait) { banner(t("hub_down", { n: wait })); await sleep(wait * 1000); }
    try {
      const res = await fn();
      if (ok(res)) { if (wait) banner(""); return res; }
      last = res?.error || t("hub_refused");
    } catch (e) { last = e?.message || String(e); }
  }
  throw new Error(last);
}

// an undelivered recording of a past life of the tab: send it from the input field of its chat
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
    banner(t("resuming", { len: clock(rec.length) }));
    await deliver({ ...rec, list, frames, whole, video }, ctx);
  } finally {
    R = null;
    paintAll();
  }
}

// on page load: what was left undelivered
async function scan() {
  try {
    const recs = await all("rec");
    const old = recs.filter((x) => Date.now() - x.wall > 7 * 864e5);   // the chat was not opened for a week: do not hoard
    for (const x of old) await forget(x.id);
    pending = recs.filter((x) => !old.includes(x)).sort((a, b) => a.wall - b.wall);
    const live = new Set(pending.map((x) => x.id));   // chunks with no recording (deleted with the bin, not finished): erase
    const orphans = new Set((await tx("blob", "readonly", (st) => st.getAllKeys())).map((k) => String(k).split("/")[0]).filter((id) => !live.has(id)));
    for (const id of orphans) await forget(id);
    if (!pending.length) return;
    banner(t("undelivered", { list: pending.map((x) => `${clock(x.length)} → ${x.key}`).join(", ") }), 15000);
    for (const b of buttons.values()) if (b.isConnected && b.parentNode?.__ctx) await resume(b.parentNode.__ctx);
  } catch { /* no IndexedDB (private mode): the recording lives only in memory, as before */ }
}

// ───── IndexedDB: rec is the recording description (phrases, frames, what is uploaded already), blob is the files `id/p|f|w|v/number` ─────
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
    // a write is strict: on disk when the transaction ends (otherwise the browser may not make it before a power cut)
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
// a chunk of the running recording goes in turn (the bin waits until it is written); for an erased one it is not written any more
const put = (r, key, val) => (r.io = r.io.then(() => (r.dead ? null : keep("blob", key, val))));
function meta(r) {
  return { id: r.id, key: r.key, wall: r.wall, voice: !!r.voice, stopped: !!r.stopped, sent: r.sent || null,
    length: r.length ?? (r.t0 != null ? performance.now() - r.t0 : 0),
    list: r.list.map(({ from, speech, to, text }) => ({ from, speech, to, text })),
    frames: r.frames.map(({ t: at, kind, phrase, n, tag }) => ({ t: at, kind, phrase, n, ...(tag != null ? { tag } : {}) })),
    tags: r.tags || [], drew: !!r.drew };
}
const saveMeta = (r) => (r.id && !r.dead ? keep("rec", null, meta(r)) : Promise.resolve());

function release(r) {
  r.island?.destroy();
  r.unconfine?.();
  r.grab?.close();
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
