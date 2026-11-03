// The recorded picture: the screen with the pen strokes on it. The pen draws in the Picture-in-Picture window over a live preview of
// the screen, not on the page, so the strokes cannot reach the video by themselves (and the recorded tab may be any tab). This module
// reads the frames of the screen track, puts the strokes on them (ink.paint) and hands out a canvas stream: that stream is what the
// recorder writes and what the frame grabber shoots. Without MediaStreamTrackProcessor / captureStream it is null and the recording
// stays as it was: the raw screen, the pen on the page.
// The picture is put together by the clock of a worker (tick.js), not by the page's timers: the hub tab is usually out of sight
// while the pen works, and the browser throttles its timers.
const EDGE = 1600;     // the long side of the picture: the recorder keeps 250 kbit/s anyway, a bigger one only costs time
const STEP = 125;      // ms between looks at the strokes; a new screen frame is put out at once, an idle picture is repeated once a second
const IDLE = 1000;

// track: the screen's video track; ink: {active() -> bool, paint(ctx, w, h, now)}
export function composer(track, workerUrl, ink) {
  const Proc = globalThis.MediaStreamTrackProcessor;
  if (!Proc || typeof HTMLCanvasElement === "undefined" || !HTMLCanvasElement.prototype.captureStream) return null;
  let reader, stream, vt, timer;
  const base = document.createElement("canvas"), out = document.createElement("canvas");
  const bg = base.getContext("2d"), og = out.getContext("2d");
  try {
    stream = out.captureStream(0);
    vt = stream.getVideoTracks()[0];
    if (!vt?.requestFrame) return null;
    reader = new Proc({ track }).readable.getReader();
  } catch { return null; }
  let has = false, fresh = false, wasInk = false, sent = 0, closed = false;
  // the screen frames: each is drawn into `base` at once and given back (the capture holds only a few frames)
  (async () => {
    for (;;) {
      const { value: f, done } = await reader.read();
      if (done || closed) { f?.close(); return; }
      try {
        const w = f.displayWidth || f.codedWidth, h = f.displayHeight || f.codedHeight, k = Math.min(1, EDGE / Math.max(w, h));
        const cw = Math.max(2, Math.round(w * k)), ch = Math.max(2, Math.round(h * k));
        if (base.width !== cw || base.height !== ch) { base.width = out.width = cw; base.height = out.height = ch; }
        bg.drawImage(f, 0, 0, cw, ch);
        has = fresh = true;
      } finally { f.close(); }
    }
  })().catch(() => {});
  const render = () => {
    if (!has || closed) return;
    const now = performance.now(), on = ink.active();
    if (!(fresh || on || wasInk || now - sent >= IDLE)) return;
    og.globalAlpha = 1;
    og.drawImage(base, 0, 0);
    if (on) ink.paint(og, out.width, out.height, now);
    vt.requestFrame();
    sent = now; fresh = false; wasInk = on;
  };
  let worker = null;
  try {
    worker = new Worker(workerUrl);
    worker.onmessage = render;
    worker.postMessage(STEP);
  } catch { timer = setInterval(render, STEP); }   // no worker: the page's own timer, which a hidden tab slows down
  return {
    stream,
    // the current picture as a bitmap (for the JPEG frames), null until the first screen frame has come
    bitmap: () => (has ? createImageBitmap(out) : Promise.resolve(null)),
    close() {
      closed = true;
      worker?.terminate();
      clearInterval(timer);
      reader.cancel().catch(() => {});
      vt.stop();
    },
  };
}
