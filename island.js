// The pen island: a small floating panel over the hub page while the screen is recorded. Pencil, rectangle, oval and line draw on
// a transparent canvas over the page, so the strokes land in the recorded video and in the frames by themselves; the island is a
// child of <html>, outside <body>, so the capture of the hub tab can leave it out (Element Capture, see confine() in main.js).
// The ink is always white and the canvas blends with `difference` (an inverse of what lies under it), so a stroke reads on any
// background without anyone measuring the screen.
// A Motion Gallery button (only when that plugin answers) opens a popover with posters; a pick tags the animation at the
// current moment of the video. The look follows the designer's mock-up (vfd-* classes in style.css, tokens of the hub theme).
import { DRAW, count, fadeAlpha, fmtDuration, matchItem, mediaUrl } from "./lib.js";

const NS = "http://www.w3.org/2000/svg";
const POS = "hub-video-feedback:island";
const EDGE = 8;        // the popover and the toast keep this far from the screen edge, and sit this far under the island
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
//     gallery: () => Promise<{items, base} | null>, onTag(item) => index, onUntag(index), onStroke(), onToggle(open)}
export function createIsland(o) {
  const hold = o.hold ?? DRAW.hold;
  const toastMs = o.toastMs ?? 3000;
  let tool = null, strokes = [], cur = null, gal = null, opened = false;
  let dirty = null, frameId = 0, wake = 0, pos = { x: 0, y: 0 };   // the area to repaint, the pending frame and fade timer, the island's place
  let pop = null, find = null, grid = null, clockTimer = 0, toast = null, toastTimer = 0, retry = 0, tip = null;

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
    b.addEventListener("click", () => pick(tool === id ? null : id));
    return b;
  });
  const sepMg = o.el("span", "vfd-sep");
  const mg = btn(o.t("tag_mg"), "mg");
  mg.dataset.act = "mg";
  mg.setAttribute("aria-haspopup", "dialog");
  mg.setAttribute("aria-expanded", "false");
  sepMg.hidden = mg.hidden = true;   // only when Motion Gallery answers
  const shut = btn(o.t("draw_close"), "close");
  shut.dataset.act = "close";
  bar.append(grip, ...tools, sepMg, mg, o.el("span", "vfd-sep"), shut);
  mg.addEventListener("click", () => (pop ? closePop() : openPop()));
  shut.addEventListener("click", () => close());

  // tooltip: under the button, for the pointer and for the keyboard
  const tipOn = (e) => {
    const t = e.target.closest?.("[data-tip]");
    if (!t || root.querySelector(".is-dragging") || (e.type === "focusin" && !t.matches(":focus-visible"))) return;
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
    if (id) closePop();
  }

  // Drawing stays off the pointer handlers: they only record points (no layout reads, no painting); one animation frame paints
  // what changed, and only inside the rectangle that changed (`dirty`). A pencil stroke being drawn adds only its new segments.
  const pad = DRAW.width / 2 + 2;
  const bounds = (s) => s.tool === "pencil" ? s.box
    : { x1: Math.min(s.a.x, s.b.x), y1: Math.min(s.a.y, s.b.y), x2: Math.max(s.a.x, s.b.x), y2: Math.max(s.a.y, s.b.y) };
  const mark = (r) => {
    dirty = dirty ? { x1: Math.min(dirty.x1, r.x1 - pad), y1: Math.min(dirty.y1, r.y1 - pad), x2: Math.max(dirty.x2, r.x2 + pad), y2: Math.max(dirty.y2, r.y2 + pad) }
      : { x1: r.x1 - pad, y1: r.y1 - pad, x2: r.x2 + pad, y2: r.y2 + pad };
  };
  const schedule = () => { if (!frameId) frameId = requestAnimationFrame(frame); };

  canvas.addEventListener("pointerdown", (e) => {
    if (!tool || e.button) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const p = { x: e.clientX, y: e.clientY };
    cur = { tool, a: p, b: p, segs: [{ x1: p.x, y1: p.y, x2: p.x, y2: p.y }], box: { x1: p.x, y1: p.y, x2: p.x, y2: p.y }, drawn: 0, done: 0 };
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
    if (cur.drawn < cur.segs.length) mark(bounds(cur));   // the tail not yet painted is painted with the fade alpha on the next frame
    cur.done = performance.now();
    cur = null;
    o.onStroke?.();
    schedule();
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);

  function paint(s, alpha) {
    g.globalAlpha = alpha;
    g.lineWidth = DRAW.width;
    g.lineCap = g.lineJoin = "round";
    g.strokeStyle = DRAW.ink;
    if (s.tool === "pencil") {
      // one path for the whole stroke: separate round-capped segments overlap and show as beads while the stroke fades
      g.beginPath();
      g.moveTo(s.segs[0].x1, s.segs[0].y1);
      for (const q of s.segs) g.lineTo(q.x2, q.y2);
      g.stroke();
      return;
    }
    g.beginPath();
    if (s.tool === "line") { g.moveTo(s.a.x, s.a.y); g.lineTo(s.b.x, s.b.y); }
    else if (s.tool === "rect") g.rect(Math.min(s.a.x, s.b.x), Math.min(s.a.y, s.b.y), Math.abs(s.b.x - s.a.x), Math.abs(s.b.y - s.a.y));
    else g.ellipse((s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2, Math.abs(s.b.x - s.a.x) / 2, Math.abs(s.b.y - s.a.y) / 2, 0, 0, 2 * Math.PI);
    g.stroke();
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
    g.globalAlpha = 1;
    for (const s of strokes) {
      if (s.tool !== "pencil" || s.done || s.drawn >= s.segs.length) continue;
      g.lineWidth = DRAW.width;
      g.lineCap = g.lineJoin = "round";
      g.strokeStyle = DRAW.ink;
      g.beginPath();
      g.moveTo(s.segs[s.drawn].x1, s.segs[s.drawn].y1);
      for (let i = s.drawn; i < s.segs.length; i++) g.lineTo(s.segs[i].x2, s.segs[i].y2);
      g.stroke();
      s.drawn = s.segs.length;
    }
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
        if (s.tool === "pencil") s.drawn = s.segs.length;
      }
      g.restore();
    }
    if (fading) schedule();
    else if (next < Infinity) wake = setTimeout(schedule, next + 1);
  }

  // dragging the island by the grip, anywhere on the page; the place is remembered. The island moves by transform (the compositor,
  // not layout): the pointer handler only keeps the last point, one animation frame moves it, and the sizes are measured once
  const size = { w: 0, h: 0 };
  const measure = () => { size.w = root.offsetWidth; size.h = root.offsetHeight; };
  const keepIn = (x, y) => ({ x: Math.min(Math.max(4, x), Math.max(4, innerWidth - size.w - 4)),
    y: Math.min(Math.max(4, y), Math.max(4, innerHeight - size.h - 4)) });
  const place = (x, y) => {
    const p = keepIn(x, y);
    if (p.x !== pos.x || p.y !== pos.y || !root.style.transform) { pos = p; root.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`; }
    return p;
  };
  const home = () => {
    measure();
    let s = null;
    try { s = JSON.parse(localStorage.getItem(POS)); } catch { /* none */ }
    if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) return place(s.x * innerWidth, s.y * innerHeight);
    return place((innerWidth - size.w) / 2, 16);   // top centre, 16 from the edge
  };
  grip.addEventListener("pointerdown", (e) => {
    if (e.button) return;
    e.preventDefault();
    tipOff();
    grip.setPointerCapture(e.pointerId);
    bar.classList.add("is-dragging");
    measure();
    if (pop) measureLayer(pop);
    if (toast) measureLayer(toast);
    const dx = e.clientX - pos.x, dy = e.clientY - pos.y;
    let last = null, step = 0;
    const apply = () => {
      step = 0;
      if (!last) return;
      place(last.clientX - dx, last.clientY - dy);
      last = null;
      if (pop) under(pop);
      if (toast) under(toast);
    };
    const move = (m) => { last = m; if (!step) step = requestAnimationFrame(apply); };
    const end = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      cancelAnimationFrame(step);
      apply();
      bar.classList.remove("is-dragging");
      try { localStorage.setItem(POS, JSON.stringify({ x: pos.x / innerWidth, y: pos.y / innerHeight })); } catch { /* no storage */ }
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
    const up = innerHeight - (pos.y + size.h) - EDGE < h + EDGE && pos.y > innerHeight - (pos.y + size.h);
    const left = Math.min(Math.max(EDGE, pos.x + size.w / 2 - w / 2), Math.max(EDGE, innerWidth - w - EDGE));
    const shift = `${left - pos.x}px 0`;
    if (el.vfShift !== shift) { el.vfShift = shift; el.style.translate = shift; }
    if (el.vfUp !== up) {
      el.vfUp = up;
      el.style.top = up ? "" : `calc(100% + ${EDGE}px)`;
      el.style.bottom = up ? `calc(100% + ${EDGE}px)` : "";
      el.style.transformOrigin = up ? "50% 100%" : "50% 0";
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
    find.focus({ preventScroll: true });
    clockTimer = setInterval(() => { tc.textContent = o.timecode(); }, 1000);
  }
  function closePop() {
    if (!pop) return;
    clearInterval(clockTimer);
    pop.remove();
    pop = find = grid = null;
    mg.setAttribute("aria-expanded", "false");
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

  const away = (e) => { if (pop && !root.contains(e.target)) closePop(); };
  const keys = (e) => {
    if (e.key !== "Escape" || !opened) return;
    if (pop) { closePop(); mg.focus({ preventScroll: true }); } else if (tool) pick(null);
  };
  const resize = () => { fit(); if (opened) { home(); if (pop) under(pop, true); if (toast) under(toast, true); } };

  function open() {
    if (opened) return;
    opened = true;
    document.documentElement.append(root);
    document.body.append(canvas);
    fit();
    home();
    addEventListener("resize", resize);
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
    dismissToast();
    tipOff();
    clearTimeout(retry);
    cancelAnimationFrame(frameId);
    clearTimeout(wake);
    frameId = 0;
    dirty = null;
    root.remove();
    canvas.remove();
    removeEventListener("resize", resize);
    removeEventListener("keydown", keys);
    document.removeEventListener("pointerdown", away, true);
    o.onToggle?.(false);
  }
  function destroy() { close(); }

  return { open, close, destroy, isOpen: () => opened, pick, box: root, canvas, strokes: () => strokes.length };
}
