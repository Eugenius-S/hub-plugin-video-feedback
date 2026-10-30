// The pen island: a small floating panel over the hub page while the screen is recorded. Pencil, rectangle, oval and line draw on
// a transparent canvas over the page, so the strokes land in the recorded video and in the frames by themselves; the island is a
// child of <html>, outside <body>, so the capture of the hub tab can leave it out (Element Capture, see confine() in main.js).
// One ink colour serves every tool: a round button next to the grip opens the colour popover (8 ready colours, a square, a hue
// strip, hex), the choice is remembered (localStorage) and applies to the next stroke on the open canvas. A stroke is drawn in
// that colour as it is, no blending and no halo.
// In full screen the island and the canvas move into the fullscreen element (the rest of the page is inert there). A video or an
// image cannot hold children, so a video or image shown full screen is swapped for our own fullscreen box with a copy of it (the
// viewer); the players' native fullscreen button is replaced, in the same place and the same look, for the time of the recording (see fsOn). An iframe, an embed or a
// canvas cannot be copied: there the island floats out into a Picture-in-Picture window (the pip button, or by pulling it past the
// edge of the window); only the island goes there, the drawing stays on the page.
// A Motion Gallery button (only when that plugin answers) opens a popover with posters; a pick tags the animation at the
// current moment of the video. The look follows the designer's mock-up (vfd-* classes in style.css, tokens of the hub theme).
import { COLORS, DRAW, INK_KEY, count, fadeAlpha, fmtDuration, hex2rgb, hsv2rgb, inkColor, matchItem, mediaUrl, rgb2hex, rgb2hsv } from "./lib.js";

const NS = "http://www.w3.org/2000/svg";
const POS = "hub-video-feedback:island";
const EDGE = 8;        // the popover and the toast keep this far from the screen edge, and sit this far under the island
const PIP_PAD = 0;     // the island's margin inside the Picture-in-Picture window: none, the window is the island
const SHOWN = 60;      // cards drawn at once in the popover
const TOOLS = ["pencil", "rect", "oval", "line"];
// outline icons from the designer's mock-up (Icons8 and Material outlined; move is Material drag_indicator, six dots), viewBox 0 0 24 24, currentColor
const ICONS = {
  move: "M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z",
  pencil: "M 18.414062 2 C 18.158062 2 17.902031 2.0979687 17.707031 2.2929688 L 5 15 C 5 15 6.005 15.005 6.5 15.5 C 6.995 15.995 6.984375 16.984375 6.984375 16.984375 C 6.984375 16.984375 8.003 17.003 8.5 17.5 C 8.997 17.997 9 19 9 19 L 21.707031 6.2929688 C 22.098031 5.9019687 22.098031 5.2689063 21.707031 4.8789062 L 19.121094 2.2929688 C 18.926094 2.0979688 18.670063 2 18.414062 2 z M 18.414062 4.4140625 L 19.585938 5.5859375 L 18.537109 6.6347656 L 17.365234 5.4628906 L 18.414062 4.4140625 z M 15.951172 6.8769531 L 17.123047 8.0488281 L 9.4609375 15.710938 C 9.2099375 15.538938 8.9455469 15.408594 8.6855469 15.308594 C 8.5875469 15.050594 8.4590625 14.789063 8.2890625 14.539062 L 15.951172 6.8769531 z M 3.6699219 17 L 3 21 L 7 20.330078 L 3.6699219 17 z",
  rect: "M20,6v12H4V6H20 M22,4H2v16h20V4L22,4z",
  oval: "M 12 2 C 6.4889971 2 2 6.4889971 2 12 C 2 17.511003 6.4889971 22 12 22 C 17.511003 22 22 17.511003 22 12 C 22 6.4889971 17.511003 2 12 2 z M 12 4 C 16.430123 4 20 7.5698774 20 12 C 20 16.430123 16.430123 20 12 20 C 7.5698774 20 4 16.430123 4 12 C 4 7.5698774 7.5698774 4 12 4 z",
  line: "M 20.292969 2.2929688 L 2.2929688 20.292969 L 3.7070312 21.707031 L 21.707031 3.7070312 L 20.292969 2.2929688 z",
  mg: "M10 16.5l6-4.5-6-4.5v9zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z",
  pip: "M 4 4 C 2.9069372 4 2 4.9069372 2 6 L 2 18 C 2 19.093063 2.9069372 20 4 20 L 20 20 C 21.093063 20 22 19.093063 22 18 L 22 6 C 22 4.9069372 21.093063 4 20 4 L 4 4 z M 4 6 L 20 6 L 20 18 L 4 18 L 4 6 z M 11 11 L 11 16 L 18 16 L 18 11 L 11 11 z",
  fs: "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z",
  fsExit: "M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z",
  trash: "M 10 2 L 9 3 L 5 3 L 4 3 L 4 5 L 5 5 L 5 20 C 5 21.093063 5.9069372 22 7 22 L 17 22 C 18.093063 22 19 21.093063 19 20 L 19 5 L 20 5 L 20 3 L 19 3 L 18 3 L 15 3 L 14 2 L 10 2 z M 7 5 L 17 5 L 17 20 L 7 20 L 7 5 z",
  close: "M 4.7070312 3.2929688 L 3.2929688 4.7070312 L 10.585938 12 L 3.2929688 19.292969 L 4.7070312 20.707031 L 12 13.414062 L 19.292969 20.707031 L 20.707031 19.292969 L 13.414062 12 L 20.707031 4.7070312 L 19.292969 3.2929688 L 12 10.585938 L 4.7070312 3.2929688 z",
  search: "M 9 2 C 5.1458514 2 2 5.1458514 2 9 C 2 12.854149 5.1458514 16 9 16 C 10.747998 16 12.345009 15.348024 13.574219 14.28125 L 14 14.707031 L 14 16 L 20 22 L 22 20 L 16 14 L 14.707031 14 L 14.28125 13.574219 C 15.348024 12.345009 16 10.747998 16 9 C 16 5.1458514 12.854149 2 9 2 z M 9 4 C 11.773268 4 14 6.2267316 14 9 C 14 11.773268 11.773268 14 9 14 C 6.2267316 14 4 11.773268 4 9 C 4 6.2267316 6.2267316 4 9 4 z",
};

export function icon(name, small) {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("class", "vfd-i" + (small ? " vfd-i16" : ""));
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", ICONS[name]);
  s.append(p);
  return s;
}

// o: {el, t, hold, toastMs, timecode: () => "01:24",
//     gallery: () => Promise<{items, base} | null>, onTag(item) => index, onUntag(index), onStroke(), onToggle(open), onStop(), onDiscard()}
export function createIsland(o) {
  const hold = o.hold ?? DRAW.hold;
  const toastMs = o.toastMs ?? 3000;
  let tool = null, strokes = [], cur = null, gal = null, opened = false;
  let dirty = null, frameId = 0, wake = 0, pos = { x: 0, y: 0 };   // the area to repaint, the pending frame and fade timer, the island's place
  let ink = DRAW.ink;
  try { ink = inkColor(localStorage.getItem(INK_KEY)) || ink; } catch { /* no storage */ }
  let pop = null, find = null, grid = null, clockTimer = 0, toast = null, toastTimer = 0, retry = 0, tip = null;
  let cpop = null, cpaint = null;   // the colour popover, and its repaint from a colour that came from outside

  const root = o.el("div", "vfd-root");
  const bar = o.el("div", "vfd-island");
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", o.t("draw_bar"));
  root.append(bar);

  const grip = o.el("div", "vfd-grip");
  grip.dataset.tip = o.t("draw_move");
  grip.setAttribute("aria-label", o.t("draw_grip"));
  grip.append(icon("move"));
  const btn = (label, name, small) => {
    const b = o.el("button", "vfd-btn");
    b.type = "button";
    b.dataset.tip = label;
    b.setAttribute("aria-label", label);
    b.append(icon(name, small));
    return b;
  };
  const tools = TOOLS.map((id) => {
    const b = btn(o.t("draw_" + id), id);
    b.dataset.tool = id;
    b.setAttribute("aria-pressed", "false");
    b.dataset.tip = `${o.t("draw_" + id)} · ${o.t("draw_release")}`;   // the right button puts the tool down: said in the tip
    b.addEventListener("click", () => pick(tool === id ? null : id));
    b.addEventListener("contextmenu", (e) => { if (tool !== id) return; e.preventDefault(); pick(null); });
    return b;
  });
  // the colour button: a round dot of the current ink, right after the grip; it opens the colour popover
  const swatch = o.el("button", "vfd-btn vfd-color");
  swatch.type = "button";
  swatch.dataset.tip = o.t("draw_color");
  swatch.dataset.act = "color";
  swatch.setAttribute("aria-haspopup", "dialog");
  swatch.setAttribute("aria-expanded", "false");
  swatch.append(o.el("span", "vfd-dot"));
  const nameOf = (hex) => o.t("color_" + (COLORS.find(([, h]) => h === hex.toUpperCase())?.[0] ?? "custom"));
  const setInk = (c, save) => {
    ink = c;
    swatch.style.setProperty("--ink", c);
    swatch.setAttribute("aria-label", o.t("draw_color_now", { name: nameOf(c) }));
    if (save) { try { localStorage.setItem(INK_KEY, c); } catch { /* no storage */ } }
  };
  setInk(ink);
  swatch.addEventListener("click", () => (cpop ? closeColor() : openColor()));
  // another tab or window of the hub picked a colour: this canvas follows, an open popover too
  const follow = (e) => { const c = e.key === INK_KEY ? inkColor(e.newValue) : null; if (c) { setInk(c); cpaint?.(c.toUpperCase(), false, true); } };
  const sepMg = o.el("span", "vfd-sep");
  const mg = btn(o.t("tag_mg"), "mg");
  mg.dataset.act = "mg";
  mg.setAttribute("aria-haspopup", "dialog");
  mg.setAttribute("aria-expanded", "false");
  sepMg.hidden = mg.hidden = true;   // only when Motion Gallery answers
  const shut = btn(o.t("draw_close"), "close");
  shut.dataset.act = "close";
  // the Picture-in-Picture button: floats the island out into its own window above everything. It is on the page only: in the window
  // there is no way back, the island can only be closed (the window's cross or ours)
  const float = btn(o.t("draw_pip"), "pip");
  float.dataset.act = "pip";
  float.hidden = !globalThis.documentPictureInPicture?.requestWindow;
  // the stop button: the red dot and the running time, as the hub's record button; only while the screen is recorded
  const sepRec = o.el("span", "vfd-sep");
  const rec = o.el("button", "vfd-btn vfd-rec");
  rec.type = "button";
  rec.dataset.act = "stop";
  const recTime = o.el("span", "vf-time");
  rec.append(o.el("span", "vf-dot"), recTime);
  // the bin before the stop button: the same as the bin by the input field - stop and erase, nothing is sent
  const trash = btn(o.t("trash"), "trash");
  trash.classList.add("vfd-trash");
  trash.dataset.act = "discard";
  trash.dataset.tip = o.t("rec_trash");
  sepRec.hidden = trash.hidden = rec.hidden = true;
  bar.append(grip, swatch, o.el("span", "vfd-sep"), ...tools, sepMg, mg, sepRec, trash, rec, o.el("span", "vfd-sep"), float, shut);
  rec.addEventListener("click", () => { o.onStop?.(); close(); });
  trash.addEventListener("click", () => { o.onDiscard?.(); close(); });
  // recording(time): the screen is recorded, the button shows the running time; recording(null): it is hidden again
  function recording(time) {
    const on = time != null;
    if (on) {
      recTime.textContent = time;
      rec.setAttribute("aria-label", o.t("rec_stop_now", { time }));
      rec.dataset.tip = o.t("rec_stop");
    }
    if (rec.hidden === !on) return;
    sepRec.hidden = trash.hidden = rec.hidden = !on;
    if (opened) { home(); pipFit(); }   // the bar changed its width: centre it again (a remembered place stays), the window follows
  }
  mg.addEventListener("click", () => (pop ? closePop() : openPop()));
  shut.addEventListener("click", () => close());
  float.addEventListener("click", () => floatOut());

  // tooltip: under the button, for the pointer and for the keyboard (not in the small window: there is no room under the island)
  const tipOn = (e) => {
    const t = e.target.closest?.("[data-tip]");
    if (!t || pipWin || root.querySelector(".is-dragging") || (e.type === "focusin" && !t.matches(":focus-visible"))) return;
    tipOff();
    tip = o.el("div", "vfd-tip", t.dataset.tip);
    t.append(tip);
  };
  const tipOff = () => { tip?.remove(); tip = null; };
  bar.addEventListener("pointerover", tipOn);
  bar.addEventListener("focusin", tipOn);
  bar.addEventListener("pointerout", tipOff);
  bar.addEventListener("focusout", tipOff);
  bar.addEventListener("click", (e) => { if (e.detail) tipOff(); });

  const canvas = o.el("canvas", "vf-draw");
  canvas.setAttribute("aria-hidden", "true");
  const g = canvas.getContext("2d");

  function fit() {
    const dpr = devicePixelRatio || 1;
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    dirty = { x1: 0, y1: 0, x2: innerWidth, y2: innerHeight };
    cancelAnimationFrame(frameId);
    frame();
  }

  function pick(id) {
    tool = id;
    for (const b of tools) b.setAttribute("aria-pressed", String(b.dataset.tool === id));
    canvas.classList.toggle("vf-on", !!id);   // no tool: the page under the canvas is clickable again
    if (id) { closePop(); closeColor(); }
  }

  // Drawing stays off the pointer handlers: they only record points (no layout reads, no painting); one animation frame paints
  // what changed, and only inside the rectangle that changed (`dirty`); the strokes touching it are painted again whole. The pencil
  // stroke being drawn is the exception: its new segments are only added on top (`drawn` counts those already on the canvas).
  const pad = DRAW.width / 2 + 2;
  const bounds = (s) => s.tool === "pencil" ? s.box
    : { x1: Math.min(s.a.x, s.b.x), y1: Math.min(s.a.y, s.b.y), x2: Math.max(s.a.x, s.b.x), y2: Math.max(s.a.y, s.b.y) };
  const mark = (r) => {
    dirty = dirty ? { x1: Math.min(dirty.x1, r.x1 - pad), y1: Math.min(dirty.y1, r.y1 - pad), x2: Math.max(dirty.x2, r.x2 + pad), y2: Math.max(dirty.y2, r.y2 + pad) }
      : { x1: r.x1 - pad, y1: r.y1 - pad, x2: r.x2 + pad, y2: r.y2 + pad };
  };
  const schedule = () => { if (!frameId) frameId = requestAnimationFrame(frame); };

  // the right button puts the tool down (the page under the canvas is clickable again); with no tool the usual menu opens
  canvas.addEventListener("contextmenu", (e) => {
    if (!tool) return;
    e.preventDefault();
    pick(null);
  });
  canvas.addEventListener("pointerdown", (e) => {
    if (!tool || e.button) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const p = { x: e.clientX, y: e.clientY };
    cur = { tool, color: ink, a: p, b: p, segs: [{ x1: p.x, y1: p.y, x2: p.x, y2: p.y }], box: { x1: p.x, y1: p.y, x2: p.x, y2: p.y }, done: 0, drawn: 0 };
    mark(bounds(cur));
    strokes.push(cur);
    schedule();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!cur) return;
    const s = cur;
    if (s.tool !== "pencil") mark(bounds(s));   // the old place of the shape is wiped, the new one painted
    const points = e.getCoalescedEvents?.() ?? [];
    for (const m of points.length ? points : [e]) {
      const p = { x: m.clientX, y: m.clientY };
      if (s.tool === "pencil") {
        // the area of the new segment (with the previous point) waits in `pend`: the frame adds the segment, or paints the stroke whole
        const r = { x1: Math.min(s.b.x, p.x), y1: Math.min(s.b.y, p.y), x2: Math.max(s.b.x, p.x), y2: Math.max(s.b.y, p.y) };
        s.pend = s.pend ? { x1: Math.min(s.pend.x1, r.x1), y1: Math.min(s.pend.y1, r.y1), x2: Math.max(s.pend.x2, r.x2), y2: Math.max(s.pend.y2, r.y2) } : r;
        s.segs.push({ x1: s.b.x, y1: s.b.y, x2: p.x, y2: p.y });
        s.box = { x1: Math.min(s.box.x1, p.x), y1: Math.min(s.box.y1, p.y), x2: Math.max(s.box.x2, p.x), y2: Math.max(s.box.y2, p.y) };
      }
      s.b = p;
    }
    if (s.tool !== "pencil") mark(bounds(s));
    schedule();
  });
  const up = () => {
    if (!cur) return;
    cur.done = performance.now();
    cur = null;
    o.onStroke?.();
    schedule();
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);

  // the stroke is one path in the picked colour as it is, with no edge or shadow: one path for the whole pencil stroke, because
  // separate round-capped segments overlap and show as beads while the stroke fades
  function paint(s, alpha) {
    g.globalAlpha = alpha;
    g.lineCap = g.lineJoin = "round";
    g.lineWidth = DRAW.width;
    g.strokeStyle = s.color;
    g.beginPath();
    if (s.tool === "pencil") {
      g.moveTo(s.segs[0].x1, s.segs[0].y1);
      for (const q of s.segs) g.lineTo(q.x2, q.y2);
      s.drawn = s.segs.length;
      s.pend = null;
    } else if (s.tool === "line") { g.moveTo(s.a.x, s.a.y); g.lineTo(s.b.x, s.b.y); }
    else if (s.tool === "rect") g.rect(Math.min(s.a.x, s.b.x), Math.min(s.a.y, s.b.y), Math.abs(s.b.x - s.a.x), Math.abs(s.b.y - s.a.y));
    else g.ellipse((s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2, Math.abs(s.b.x - s.a.x) / 2, Math.abs(s.b.y - s.a.y) / 2, 0, 0, 2 * Math.PI);
    g.stroke();
  }

  // the new segments of a pencil stroke on top of what is already there (a stroke that has not started to fade is opaque)
  function extend(s) {
    g.globalAlpha = 1;
    g.lineCap = g.lineJoin = "round";
    g.lineWidth = DRAW.width;
    g.strokeStyle = s.color;
    g.beginPath();
    const from = Math.max(0, s.drawn - 1);
    g.moveTo(s.segs[from].x1, s.segs[from].y1);
    for (let i = from; i < s.segs.length; i++) g.lineTo(s.segs[i].x2, s.segs[i].y2);
    g.stroke();
    s.drawn = s.segs.length;
    s.pend = null;
  }

  // a finished stroke stays `hold` ms and fades out; a stroke being drawn is always whole. Nothing runs while strokes only wait:
  // a timer wakes the frame when the first one starts to fade, and the frames run only during the fade itself.
  function frame() {
    frameId = 0;
    clearTimeout(wake);
    const now = performance.now();
    let fading = false, next = Infinity;
    strokes = strokes.filter((s) => {
      if (!s.done || !hold) return true;
      const age = now - s.done;
      if (age >= hold + DRAW.fade) { mark(bounds(s)); return false; }
      if (age >= hold) { mark(bounds(s)); fading = true; } else next = Math.min(next, hold - age);
      return true;
    });
    const open = strokes.filter((s) => s.pend);
    if (dirty) for (const s of open) mark(s.pend);   // something else is repainted anyway: the stroke is painted whole with it
    else for (const s of open) extend(s);
    if (dirty) {
      const x = Math.floor(dirty.x1) - 1, y = Math.floor(dirty.y1) - 1, w = Math.ceil(dirty.x2) + 1 - x, h = Math.ceil(dirty.y2) + 1 - y;
      dirty = null;
      g.save();
      g.beginPath();
      g.rect(x, y, w, h);
      g.clip();
      g.clearRect(x, y, w, h);
      for (const s of strokes) {
        const b = bounds(s);
        if (b.x2 + pad < x || b.x1 - pad > x + w || b.y2 + pad < y || b.y1 - pad > y + h) continue;
        paint(s, s.done ? fadeAlpha(now - s.done, hold) : 1);
      }
      g.restore();
    }
    if (fading) schedule();
    else if (next < Infinity) wake = setTimeout(schedule, next + 1);
  }

  // dragging the island by the grip, anywhere on the page; the place is remembered. The island moves by transform (the compositor,
  // not layout): the pointer handler only keeps the last point, one animation frame moves it, and the sizes are measured once
  const size = { w: 0, h: 0 };
  let k = 1;   // the island's scale (in full screen it grows with the screen, see scale())
  // the window the island lives in: the hub page, or the Picture-in-Picture window while it floats there
  let win = window, pipWin = null, pipAuto = false;
  const vw = () => win.innerWidth, vh = () => win.innerHeight;
  const measure = () => { size.w = root.offsetWidth * k; size.h = root.offsetHeight * k; };   // scale does not change layout sizes: they are multiplied
  const keepIn = (x, y) => ({ x: Math.min(Math.max(4, x), Math.max(4, vw() - size.w - 4)),
    y: Math.min(Math.max(4, y), Math.max(4, vh() - size.h - 4)) });
  const put = () => { root.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)${k === 1 ? "" : ` scale(${k})`}`; };   // the scale goes after the move: the move is not scaled
  const place = (x, y) => {
    const p = keepIn(x, y);
    if (p.x !== pos.x || p.y !== pos.y || !root.style.transform) { pos = p; put(); }
    return p;
  };
  const home = () => {
    measure();
    if (pipWin) return pos = { x: PIP_PAD, y: PIP_PAD };   // in its own window the island sits in the corner, CSS places it
    let s = null;
    try { s = JSON.parse(localStorage.getItem(POS)); } catch { /* none */ }
    if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) return place(s.x * innerWidth, s.y * innerHeight);
    return place((innerWidth - size.w) / 2, 16);   // top centre, 16 from the edge
  };
  grip.addEventListener("pointerdown", (e) => {
    if (e.button || pipWin) return;   // in its own window the system moves it
    e.preventDefault();
    tipOff();
    grip.setPointerCapture(e.pointerId);
    bar.classList.add("is-dragging");
    measure();
    if (pop) measureLayer(pop);
    if (cpop) measureLayer(cpop);
    if (toast) measureLayer(toast);
    const dx = e.clientX - pos.x, dy = e.clientY - pos.y;
    let last = null, step = 0;
    const apply = () => {
      step = 0;
      if (!last) return;
      place(last.clientX - dx, last.clientY - dy);
      last = null;
      if (pop) under(pop);
      if (cpop) under(cpop);
      if (toast) under(toast);
    };
    const move = (m) => { last = m; if (!step) step = requestAnimationFrame(apply); };
    const end = (u) => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      cancelAnimationFrame(step);
      apply();
      bar.classList.remove("is-dragging");
      try { localStorage.setItem(POS, JSON.stringify({ x: pos.x / innerWidth, y: pos.y / innerHeight })); } catch { /* no storage */ }
      // let go at the edge or outside of the browser window (the pointer is captured, so its coordinates keep coming, and in a
      // maximized window it stops at the screen edge): the island floats out into its own window on top of everything.
      // The release is a user action, which the window needs
      if (u.type === "pointerup" && (u.clientX <= 0 || u.clientY <= 0 || u.clientX >= innerWidth - 1 || u.clientY >= innerHeight - 1)) floatOut();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  });

  // a layer (popover, toast) centred under the island, 8 below it; kept on the screen, flips above at the bottom edge.
  // Works from the known place and the measured sizes (no layout reads while dragging), moves by `translate`, writes only a change
  const measureLayer = (el) => { el.vfW = el.offsetWidth; el.vfH = el.offsetHeight; };
  function under(el, fresh) {
    if (fresh || el.vfW === undefined) measureLayer(el);
    const w = el.vfW, h = el.vfH;
    const up = !pipWin && vh() - (pos.y + size.h) - EDGE < h + EDGE && pos.y > vh() - (pos.y + size.h);
    // vfStart (the colour popover): flush with the island's left edge, not centred
    const want = el.vfStart ? pos.x : pos.x + size.w / 2 - w / 2;
    const left = Math.min(Math.max(EDGE, want), Math.max(EDGE, vw() - w - EDGE));
    const shift = `${left - pos.x}px 0`;
    if (el.vfShift !== shift) { el.vfShift = shift; el.style.translate = shift; }
    if (el.vfUp !== up) {
      el.vfUp = up;
      el.style.top = up ? "" : `calc(100% + ${EDGE}px)`;
      el.style.bottom = up ? `calc(100% + ${EDGE}px)` : "";
      const x = el.vfStart ? "26px" : "50%";
      el.style.transformOrigin = up ? `${x} 100%` : `${x} 0`;
    }
  }

  // Motion Gallery: a search over the titles, a pick tags the animation at this moment
  function fill() {
    const q = find.value.trim().toLowerCase();
    const hit = gal.items.filter((x) => matchItem(x, q)).slice(0, SHOWN);
    grid.replaceChildren(...(hit.length ? hit.map(card) : [o.el("div", "vfd-none", o.t("tag_none"))]));
  }
  function card(x) {
    const b = o.el("button", "vfd-card");
    b.type = "button";
    const poster = o.el("span", "vfd-poster");
    const url = mediaUrl(gal.base, x.poster);
    if (url) {
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.src = url;
      poster.append(img);
    }
    const d = fmtDuration(x.duration);
    if (d) poster.append(o.el("span", "vfd-dur", d));
    b.append(poster, o.el("span", "vfd-card-title", x.title || x.slug));
    b.addEventListener("click", () => choose(x));
    return b;
  }
  function openPop() {
    if (pop || !gal?.items?.length) return;
    closeColor();
    dismissToast();
    pop = o.el("div", "vfd-pop");
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", o.t("tag_mg"));
    const title = o.el("div", "vfd-pop-title", "Motion Gallery");
    title.append(o.el("span", "vfd-pop-num", count(gal.items.length, o.t("tag_count_forms"))));
    const label = o.el("label", "vfd-search");
    find = o.el("input", "vfd-find");
    find.type = "text";
    find.autocomplete = "off";
    find.spellcheck = false;
    find.placeholder = o.t("tag_search");
    find.setAttribute("aria-label", find.placeholder);
    find.addEventListener("input", fill);
    find.addEventListener("keydown", (e) => { if (e.key === "Enter") grid.querySelector(".vfd-card")?.click(); });
    label.append(icon("search", true), find);
    grid = o.el("div", "vfd-grid");
    const foot = o.el("div", "vfd-pop-foot");
    const tc = o.el("span", "tc", o.timecode());
    const [pre, post] = o.t("tag_foot", { t: "\n" }).split("\n");
    foot.append(pre, tc, post);
    pop.append(o.el("div", "vfd-pop-head"), grid, foot);
    pop.firstChild.append(title, label);
    root.append(pop);
    mg.setAttribute("aria-expanded", "true");
    fill();
    under(pop);
    pipFit();
    find.focus({ preventScroll: true });
    clockTimer = setInterval(() => { tc.textContent = o.timecode(); }, 1000);
  }
  function closePop() {
    if (!pop) return;
    clearInterval(clockTimer);
    pop.remove();
    pop = find = grid = null;
    mg.setAttribute("aria-expanded", "false");
    pipFit();
  }
  // the colour popover: 8 ready colours, a saturation/brightness square, a hue strip, a hex field. A ready colour sets the ink and
  // closes; the square, the strip and the field set it live and keep the popover open. Everything goes to setInk (and localStorage).
  function openColor() {
    if (cpop) return;
    closePop();
    dismissToast();
    const box = o.el("div", "vfd-cpop");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", o.t("draw_color"));
    const row = o.el("div", "vfd-swatches");
    row.setAttribute("role", "radiogroup");
    row.setAttribute("aria-label", o.t("draw_colors"));
    const sws = COLORS.map(([n, hex]) => {
      const b = o.el("button", "vfd-sw");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-label", o.t("color_" + n));
      b.style.setProperty("--c", hex);
      b.dataset.hex = hex;
      row.append(b);
      return b;
    });
    const slider = (cls, label) => {
      const e = o.el("div", cls);
      e.tabIndex = 0;
      e.setAttribute("role", "slider");
      e.setAttribute("aria-label", o.t(label));
      const t = o.el("span", "vfd-thumb");
      e.append(t);
      return [e, t];
    };
    const [sv, svT] = slider("vfd-sv", "draw_sv");
    const [hue, hT] = slider("vfd-hue", "draw_hue");
    hue.setAttribute("aria-valuemin", "0");
    hue.setAttribute("aria-valuemax", "360");
    const pickBox = o.el("div", "vfd-pick");
    pickBox.append(sv, hue);
    const hexL = o.el("label", "vfd-hex");
    const hDot = o.el("span", "vfd-dot");
    const inp = o.el("input");
    inp.maxLength = 6;
    inp.spellcheck = false;
    inp.setAttribute("aria-label", o.t("draw_hex"));
    hexL.append(hDot, o.el("span", "", "#"), inp);
    box.append(row, pickBox, hexL);

    let [h, s, v] = rgb2hsv(hex2rgb(ink));
    // external: the colour came from another tab, it is shown but not written back
    const paintAll = (hex, fromInput, external) => {
      for (const b of sws) {
        const on = b.dataset.hex === hex;
        b.setAttribute("aria-checked", String(on));
        b.tabIndex = on ? 0 : -1;
      }
      if (!sws.some((b) => b.tabIndex === 0)) sws[0].tabIndex = 0;
      sv.style.setProperty("--h", h);
      svT.style.left = s * 100 + "%";
      svT.style.top = (1 - v) * 100 + "%";
      svT.style.setProperty("--c", hex);
      hT.style.left = h / 360 * 100 + "%";
      hT.style.setProperty("--c", `hsl(${h} 100% 50%)`);
      hue.setAttribute("aria-valuenow", String(Math.round(h)));
      hDot.style.setProperty("--ink", hex);
      if (!fromInput) inp.value = hex.slice(1);
      if (!external) setInk(hex, true);
    };
    const fromHsv = () => paintAll(rgb2hex(...hsv2rgb(h, s, v)));
    const setHex = (hex, fromInput, external) => { [h, s, v] = rgb2hsv(hex2rgb(hex)); paintAll(hex, fromInput, external); };
    cpaint = (hex, fromInput, external) => setHex(hex, fromInput, external);
    for (const b of sws) b.addEventListener("click", () => { setHex(b.dataset.hex); closeColor(true); });
    row.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const next = sws[(sws.indexOf(root.ownerDocument.activeElement) + d + sws.length) % sws.length];
      next.focus({ preventScroll: true });
      setHex(next.dataset.hex);
    });
    // a drag on the square or the strip: pointer capture, the position clamps to the area
    const drag = (area, fn) => area.addEventListener("pointerdown", (e) => {
      if (e.button) return;
      e.preventDefault();
      area.focus({ preventScroll: true });
      area.setPointerCapture(e.pointerId);
      const go = (ev) => {
        const r = area.getBoundingClientRect();
        fn(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)));
        fromHsv();
      };
      go(e);
      area.addEventListener("pointermove", go);
      const end = () => { area.removeEventListener("pointermove", go); area.removeEventListener("pointerup", end); area.removeEventListener("pointercancel", end); };
      area.addEventListener("pointerup", end);
      area.addEventListener("pointercancel", end);
    });
    drag(sv, (x, y) => { s = x; v = 1 - y; });
    drag(hue, (x) => { h = x * 360; });
    // arrows on a slider: 1%, with Shift 10%
    const arrows = (area, fn) => area.addEventListener("keydown", (e) => {
      const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!k) return;
      e.preventDefault();
      const st = e.shiftKey ? 0.1 : 0.01;
      fn(k[0] * st, k[1] * st);
      fromHsv();
    });
    const clamp = (x) => Math.min(1, Math.max(0, x));
    arrows(sv, (dx, dy) => { s = clamp(s + dx); v = clamp(v - dy); });
    arrows(hue, (dx, dy) => { h = clamp(h / 360 + dx - dy) * 360; });
    inp.addEventListener("input", () => { if (/^[0-9a-f]{6}$/i.test(inp.value)) setHex("#" + inp.value.toUpperCase(), true); });
    box.vfStart = true;
    root.append(box);
    cpop = box;
    swatch.setAttribute("aria-expanded", "true");
    tipOff();
    setHex(ink.toUpperCase(), false, true);
    under(box, true);
    pipFit();
  }
  function closeColor(refocus) {
    if (!cpop) return;
    cpop.remove();
    cpop = cpaint = null;
    swatch.setAttribute("aria-expanded", "false");
    pipFit();
    if (refocus) swatch.focus({ preventScroll: true });
  }
  function choose(x) {
    const tc = o.timecode();
    const index = o.onTag?.(x);
    closePop();
    if (index !== -1) showToast(tc, x.title || x.slug, index);   // -1: no tag was set (countdown or the recording is stopping)
  }

  // after a tag: "01:24 · title" with Undo, 3 s
  function showToast(tc, title, index) {
    dismissToast();
    toast = o.el("div", "vfd-toast");
    toast.setAttribute("role", "status");
    const text = o.el("span", "vfd-toast-text");
    text.append(o.el("span", "tc", tc), " · " + title);
    const undo = o.el("button", "vfd-toast-undo", o.t("tag_undo"));
    undo.type = "button";
    undo.addEventListener("click", () => { o.onUntag?.(index); dismissToast(); });
    toast.append(icon("mg", true), text, undo);
    root.append(toast);
    under(toast);
    toastTimer = setTimeout(dismissToast, toastMs);
  }
  function dismissToast() {
    clearTimeout(toastTimer);
    toast?.remove();
    toast = null;
  }

  // Motion Gallery answers slowly while it starts: ask again until it does
  function ask() {
    clearTimeout(retry);
    o.gallery?.().then((x) => {
      if (!opened) return;
      gal = x?.items?.length ? x : null;
      sepMg.hidden = mg.hidden = !gal;
      home();   // the bar got wider: centre it again (a remembered place stays)
      if (!gal) retry = setTimeout(ask, 15000);
    }).catch(() => { if (opened) retry = setTimeout(ask, 15000); });
  }

  const away = (e) => {
    if (root.contains(e.target)) return;
    if (pop) closePop();
    if (cpop) closeColor();
  };
  const keys = (e) => {
    if (e.key !== "Escape" || !opened) return;
    if (cpop) closeColor(true);
    else if (pop) { closePop(); mg.focus({ preventScroll: true }); } else if (tool) pick(null);
  };
  const resize = () => { fit(); if (opened) { scale(); home(); if (pop) under(pop, true); if (cpop) under(cpop, true); if (toast) under(toast, true); } };

  // Something is shown in the Fullscreen API: everything outside of it is inert, and the page under it is not drawn over. So the island
  // and the canvas go inside the element that is fullscreen, and back to the page when it leaves. The whole page (<html>) needs nothing.
  // video, iframe and the like cannot have children. A <video> or <img> that goes fullscreen (the player's own button, which cannot be
  // caught) is swapped at once for our own fullscreen box with a copy of it (the viewer), and the island goes into that box. An iframe,
  // an embed and a canvas cannot be copied: there the island floats out into its Picture-in-Picture window, which fullscreen cannot cover.
  const NO_CHILDREN = /^(video|audio|iframe|embed|object|img|canvas|input|textarea|select|br|hr)$/;
  const COPYABLE = /^(video|img)$/;
  let viewer = null;               // {box, el (the original), copy, played}
  const gaveUp = new WeakSet();    // elements whose copy failed: they stay in their own fullscreen
  const canvasTo = (c) => { if (canvas.parentNode !== c) c.append(canvas); };
  // In full screen the island grows with the screen: the page sizes are drawn for a 900px high window, so k = height / 900 within
  // 1..1.5 (scale, not zoom: the place is already a transform). In its own window it keeps its size.
  const fsK = () => document.fullscreenElement && !pipWin ? Math.min(1.5, Math.max(1, window.innerHeight / 900)) : 1;
  const scale = () => { k = fsK(); if (root.style.transform) put(); };
  function mount() {
    const fe = document.fullscreenElement;
    const inside = fe && fe !== document.documentElement && !NO_CHILDREN.test(fe.localName) && fe.isConnected ? fe : null;
    const [r, c] = inside ? [inside, inside] : [document.documentElement, document.body];
    if (!pipWin && root.parentNode !== r) r.append(root);   // while it floats, the island sits in its own window
    canvasTo(c);
    if (opened && fsBtn.parentNode !== r) r.append(fsBtn);
    scale();
  }

  function enterViewer(el) {
    const box = o.el("div", "vfd-viewer");
    let copy;
    if (el.localName === "video") {
      copy = document.createElement("video");
      copy.src = el.currentSrc || el.src;
      copy.poster = el.poster;
      copy.controls = true;
      copy.loop = el.loop;
      copy.muted = el.muted;
      copy.volume = el.volume;
      copy.playbackRate = el.playbackRate;
      copy.playsInline = true;
      copy.controlsList.add("nofullscreen");   // its own button would take it out of our box: ours exits
      copy.setAttribute("data-vfd-fs", "");
      copy.addEventListener("loadedmetadata", () => { try { copy.currentTime = el.currentTime; } catch { /* a live stream */ } }, { once: true });
      copy.addEventListener("error", () => { if (viewer?.copy === copy) failViewer(el); }, { once: true });
    } else {
      copy = document.createElement("img");
      copy.src = el.currentSrc || el.src;
      copy.alt = el.alt;
    }
    copy.className = "vfd-viewer-media";
    const played = el.localName === "video" && !el.paused && !el.ended;
    if (el.localName === "video") el.pause();
    box.append(copy);
    document.body.append(box);
    viewer = { box, el, copy, played };
    return box.requestFullscreen().then(() => { if (played) copy.play().catch(() => {}); }).catch(() => { failViewer(el); });
  }
  // leaving: the original gets the time and the playing state back, our box goes away
  function leaveViewer(drop) {
    const v = viewer;
    if (!v) return;
    viewer = null;
    if (v.el.localName === "video" && !drop) {
      try { v.el.currentTime = v.copy.currentTime; v.el.volume = v.copy.volume; v.el.muted = v.copy.muted; } catch { /* gone */ }
      if (!v.copy.paused && !v.copy.ended) v.el.play?.().catch(() => {});
    }
    v.copy.pause?.();
    v.box.remove();
  }
  // the copy cannot play (a stream, a protected source): back to the original in its own fullscreen, the island floats out
  function failViewer(el) {
    gaveUp.add(el);
    leaveViewer(true);
    el.requestFullscreen?.().catch(() => {});
    floatOut(true);
  }
  const screenChanged = () => {
    if (!opened) return;
    const fe = document.fullscreenElement;
    if (viewer && fe !== viewer.box) leaveViewer();
    if (!fe && pipWin && pipAuto) closePip();   // it floated only to get past a fullscreen: back on the page
    if (fe && COPYABLE.test(fe.localName) && !gaveUp.has(fe) && !viewer) { enterViewer(fe); return; }
    if (fe && /^(iframe|embed|object|canvas)$/.test(fe.localName)) floatOut(true);
    mount();
    resize();
  };

  // The player's own fullscreen button cannot be caught: the browser enters fullscreen with the click already used up, and moving
  // it to our box needs a new user action. So while the island is open the videos lose that button (controlsList nofullscreen) and
  // ours takes its place on hover (its click is a fresh user action); a double click does the same, and a page calling
  // requestFullscreen() on a video or an image gets the viewer too. Inside the viewer the same button leaves full screen.
  // Our button copies the native one: the same place on the bar (measured on Chrome's own bar: the icon's centre is 72px from the
  // right edge of the video and 48px from the bottom, the hover disc is 36px), the same icon, and it is gone where the native bar
  // drops its fullscreen button (a video narrower than 197px or lower than 60px).
  // In our full screen box the button is bigger, a round 48px with a 36px icon (CSS .is-big), and stands where the native one stood:
  // its centre is 72/48px from the corner in a window up to 1440px wide, 112/56px in a wider one (the native bar grows there).
  const FS_SIZE = 36, FS_RIGHT = 72, FS_BOTTOM = 48, FS_SIZE_FS = 48, FS_RIGHT_WIDE = 112, FS_BOTTOM_WIDE = 56, FS_WIDE = 1440, FS_MIN_W = 197, FS_MIN_H = 60, FS_IDLE = 3000;
  const stripped = new Set();       // the videos whose native button we took away (and give back)
  const fsBtn = o.el("button", "vfd-fs");
  fsBtn.type = "button";
  fsBtn.hidden = true;
  fsBtn.append(icon("fs"));
  let fsFor = null, fsWatch = null, fsTimer = 0, fsFrame = 0, fsHooked = null, fsIdle = 0;
  const strip = () => {
    for (const v of document.querySelectorAll("video")) {
      if (stripped.has(v) || v.controlsList.contains("nofullscreen")) continue;   // already ours, or the page forbids it
      v.controlsList.add("nofullscreen");
      v.setAttribute("data-vfd-fs", "");   // the css hides the greyed-out native button that controlsList leaves in its place
      stripped.add(v);
    }
  };
  const swapIcon = (name) => fsBtn.firstChild.firstChild.setAttribute("d", ICONS[name]);
  const fsHide = () => { clearTimeout(fsIdle); fsFor = null; fsBtn.hidden = true; };
  const offered = (v) => v && v.controls && (stripped.has(v) || v === viewer?.copy);
  const fsShow = (v) => {
    const r = v.getBoundingClientRect();
    if (r.width < FS_MIN_W || r.height < FS_MIN_H) return fsHide();
    const out = v === viewer?.copy;
    if (fsFor !== v || fsBtn.hidden) {
      const t = o.t(out ? "draw_fs_exit" : "draw_fs");
      fsBtn.title = t;
      fsBtn.setAttribute("aria-label", t);
      swapIcon(out ? "fsExit" : "fs");
    }
    fsFor = v;
    fsBtn.hidden = false;
    fsBtn.classList.toggle("is-big", out);
    const wide = out && window.innerWidth > FS_WIDE, d = out ? FS_SIZE_FS : FS_SIZE;
    const x = r.right - (wide ? FS_RIGHT_WIDE : FS_RIGHT) - d / 2, y = r.bottom - (wide ? FS_BOTTOM_WIDE : FS_BOTTOM) - d / 2;
    fsBtn.style.transform = `translate(${x}px, ${y}px)`;
    clearTimeout(fsIdle);   // the native bar goes away after a few seconds of a still mouse over a playing video; so does the button
    if (!v.paused) fsIdle = setTimeout(fsHide, FS_IDLE);
  };
  const videoAt = (e) => {
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      if (el === fsBtn) return fsFor;
      if (el.localName === "video") return offered(el) ? el : null;
    }
    return null;
  };
  const fsMove = (e) => {
    if (fsFrame) return;
    fsFrame = requestAnimationFrame(() => {
      fsFrame = 0;
      const v = opened ? videoAt(e) : null;
      if (v) fsShow(v); else fsHide();
    });
  };
  const fsDouble = (e) => {
    if (!opened) return;
    const v = e.target?.localName === "video" ? e.target : null;
    if (!offered(v) || fsBtn.contains(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    fsGo(v);
  };
  function fsGo(v) {
    if (v === viewer?.copy) { document.exitFullscreen?.().catch(() => {}); return; }
    if (!viewer && !gaveUp.has(v)) enterViewer(v);
  }
  fsBtn.addEventListener("click", (e) => { e.stopPropagation(); if (fsFor) fsGo(fsFor); fsHide(); });
  const hookFullscreen = () => {
    const was = {};
    for (const name of ["requestFullscreen", "webkitRequestFullscreen"]) {
      const orig = Element.prototype[name];
      if (!orig) continue;
      const mine = function (...a) {
        if (opened && !viewer && COPYABLE.test(this.localName) && this.isConnected && !gaveUp.has(this)) return enterViewer(this);
        return orig.apply(this, a);
      };
      Element.prototype[name] = mine;
      was[name] = [orig, mine];
    }
    return was;
  };
  function fsOn() {
    strip();
    fsWatch = new MutationObserver(() => { clearTimeout(fsTimer); fsTimer = setTimeout(strip, 300); });
    fsWatch.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("pointermove", fsMove, { capture: true, passive: true });
    document.addEventListener("scroll", fsHide, { capture: true, passive: true });
    document.addEventListener("dblclick", fsDouble, true);
    fsHooked = hookFullscreen();
  }
  function fsOff() {
    fsWatch?.disconnect();
    fsWatch = null;
    clearTimeout(fsTimer);
    cancelAnimationFrame(fsFrame); fsFrame = 0;
    document.removeEventListener("pointermove", fsMove, true);
    document.removeEventListener("scroll", fsHide, true);
    document.removeEventListener("dblclick", fsDouble, true);
    for (const [name, [orig, mine]] of Object.entries(fsHooked || {})) if (Element.prototype[name] === mine) Element.prototype[name] = orig;
    fsHooked = null;
    for (const v of stripped) { v.controlsList.remove("nofullscreen"); v.removeAttribute("data-vfd-fs"); }
    stripped.clear();
    fsHide();
    fsBtn.remove();
  }

  // Picture-in-Picture: the island in a small window of its own that the OS keeps above every other window, even over a fullscreen
  // video and over other applications. Only the island moves there: the drawing stays on the hub page (a browser cannot draw over
  // other programs). The window needs a user action (a click, letting go of the grip, the player's fullscreen button).
  const canPip = () => !!globalThis.documentPictureInPicture?.requestWindow;
  const copyStyles = (to) => {
    for (const a of document.documentElement.attributes) to.documentElement.setAttribute(a.name, a.value);
    to.documentElement.classList.add("vfd-pip-doc");
    for (const sh of document.styleSheets) {
      try {
        if (sh.href) {
          const l = to.createElement("link");
          l.rel = "stylesheet";
          l.href = sh.href;
          to.head.append(l);
        } else {
          const st = to.createElement("style");
          st.textContent = [...sh.cssRules].map((r) => r.cssText).join("\n");
          to.head.append(st);
        }
      } catch { /* a sheet that cannot be read is skipped */ }
    }
  };
  async function floatOut(auto) {
    if (pipWin || !opened || !canPip()) return false;
    closePop(); closeColor(); dismissToast(); tipOff();
    root.classList.add("vfd-pip");   // measured as it will look in the window (the timer has room for 10:00, no button to float out), and put back before a paint
    const k0 = k, fh = float.hidden;
    k = 1;
    float.hidden = true;
    measure();
    k = k0;
    float.hidden = fh;
    root.classList.remove("vfd-pip");
    let w;
    try {
      w = await documentPictureInPicture.requestWindow({ width: Math.ceil(size.w) + 2 * PIP_PAD, height: Math.ceil(size.h) + 2 * PIP_PAD });
    } catch { return false; }
    if (!opened || pipWin) { w.close(); return false; }
    copyStyles(w.document);
    w.document.body.className = document.body.className;
    pipWin = w; win = w; pipAuto = !!auto;
    root.classList.add("vfd-pip");
    root.style.transform = "";
    w.document.body.append(root);
    float.hidden = true;   // the way back is not offered: the window is only closed
    w.addEventListener("keydown", keys);
    w.document.addEventListener("pointerdown", away, true);
    // the person closed the window: the island is closed too (the recording goes on, the pen on the page brings it back).
    // A window opened only to get past a fullscreen element just goes back to the page when that ends
    w.addEventListener("pagehide", () => {
      if (pipWin !== w) return;
      const fs = pipAuto;
      leavePip();
      if (fs) { if (opened) { mount(); fit(); home(); } } else close();
    });
    home();
    o.onFloat?.(true);
    return true;
  }
  // the island is no longer in the window (it was closed, or goes back to the page); returns the window
  function leavePip() {
    const w = pipWin;
    if (!w) return null;
    pipWin = null; win = window; pipAuto = false;
    w.removeEventListener("keydown", keys);
    closePop(); closeColor(); dismissToast(); tipOff();
    root.classList.remove("vfd-pip");
    root.style.transform = "";
    float.hidden = !canPip();
    o.onFloat?.(false);
    return w;
  }
  function closePip() {
    const w = leavePip();
    if (!w) return;
    if (opened) { mount(); fit(); home(); }
    try { w.close(); } catch { /* gone */ }
  }
  // the window is exactly the panel, and follows it when the buttons change; it grows for a popover and shrinks back.
  // It can only change size on a user action (the click that opened the popover or pressed Record); without one the size stays
  function pipFit() {
    const w = pipWin;
    if (!w) return;
    measure();
    const layer = pop || cpop || toast;
    const lw = layer ? layer.offsetWidth : 0, lh = layer ? layer.offsetHeight + EDGE : 0;
    try {
      w.resizeTo(Math.ceil(Math.max(size.w, lw)) + 2 * PIP_PAD + (w.outerWidth - w.innerWidth), Math.ceil(size.h + lh) + 2 * PIP_PAD + (w.outerHeight - w.innerHeight));
    } catch { /* no user action */ }
  }

  // The island floats out into its own window by itself (a whole screen or a window would hide it on the page, and a tab
  // recording is no worse off). The window needs a user action, and the click on "Record" is used up by the screen pick, so when the browser refuses,
  // the first press on the island (or on whatever also(target) accepts, the plugin's own buttons) opens it. A window the person
  // closed is not opened again by itself.
  let armed = null;
  const disarm = () => { if (armed) { document.removeEventListener("pointerdown", armed, true); armed = null; } };
  function arm(also) {
    if (armed || !opened || pipWin) return;
    armed = (e) => {
      if (!root.contains(e.target) && !also?.(e.target)) return;
      disarm();
      // started inside the press: that press is the user action the window needs
      floatOut(false).then((ok) => { if (!ok) arm(also); });
    };
    document.addEventListener("pointerdown", armed, true);
  }
  async function floatForScreen(also) {
    if (!opened || pipWin || !canPip()) return !!pipWin;
    if (await floatOut(false)) return true;
    arm(also);
    return false;
  }

  function open() {
    if (opened) return;
    opened = true;
    mount();
    fit();
    home();
    addEventListener("resize", resize);
    document.addEventListener("fullscreenchange", screenChanged);
    fsOn();
    addEventListener("storage", follow);
    addEventListener("keydown", keys);
    document.addEventListener("pointerdown", away, true);
    o.onToggle?.(true);
    ask();
  }
  function close() {
    if (!opened) return;
    opened = false;
    strokes = []; cur = null;
    pick(null);
    closePop();
    closeColor();
    dismissToast();
    tipOff();
    clearTimeout(retry);
    cancelAnimationFrame(frameId);
    clearTimeout(wake);
    frameId = 0;
    dirty = null;
    disarm();
    closePip();
    leaveViewer();
    fsOff();
    root.remove();
    canvas.remove();
    removeEventListener("resize", resize);
    document.removeEventListener("fullscreenchange", screenChanged);
    removeEventListener("storage", follow);
    removeEventListener("keydown", keys);
    document.removeEventListener("pointerdown", away, true);
    o.onToggle?.(false);
  }
  function destroy() { close(); }

  return { open, close, destroy, isOpen: () => opened, pick, recording, floatForScreen, isFloating: () => !!pipWin, box: root, canvas, strokes: () => strokes.length };
}
