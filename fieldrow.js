// The button in the input field's bottom row on a core without the composer.tools slot (the shared release). There a plugin
// has only session.composer, a row above the field, and the Clean theme draws that row as a card of its own: an empty white
// card over the field with the buttons in its corners. So the plugin draws into a holder of its own that stands in the
// field's row before the mic, where composer.tools stands (the theme's fit.js shares the row with them by the same class),
// and its slot root stays empty. The field keeps
// only its own nodes in the row and drops the holder on every redraw: an observer of the row puts it back before the page
// paints. A host whose slots are all empty is not shown. With no field (a closed session) the holder stays in the root, the
// row above as before.
// The same file is in video-feedback, hub-design and motion-gallery: keep the copies equal (the style goes in once, by id).
const STYLE_ID = "hub-field-tools-v1";
const CSS = `
.slot-host.composer > .slot-field-root:empty { display: none !important; }
.slot-host.composer:has(> .slot-field-root):not(:has(> :not(:empty))) { display: none !important; }
.slot-field-tools { display: inline-flex; flex: none; align-items: center; gap: var(--space-1, 4px); }
.slot-field-tools:empty, form.composer.rec > .bar > .slot-field-tools { display: none !important; }
.slot-field-tools .btn.round .icon, .slot-field-tools .btn.round > svg { width: var(--tool-icon, 16px); height: var(--tool-icon, 16px); }
.slot-field-tools .btn.round:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
html.th-clean .slot-field-tools .btn.round { box-sizing: border-box; min-width: 0; height: 32px; min-height: 0; border: 0; border-radius: 8px; background: none; }
html.th-clean .slot-field-tools .btn.round:has(> :is(svg, .icon):only-child) { width: 32px; padding: 0; color: var(--muted-foreground); }
html.th-clean .slot-field-tools .btn.round > :is(svg, .icon) { width: 16px; height: 16px; }
@media (hover: hover) and (pointer: fine) {
  html.th-clean .slot-field-tools .btn.round:hover { background: var(--c-fill); }
  html.th-clean .slot-field-tools .btn.round:has(> :is(svg, .icon):only-child):hover { color: var(--c-t1); }
}
@media (max-width: 760px) {
  html.th-clean .slot-field-tools .btn.round { height: 36px; }
  html.th-clean .slot-field-tools .btn.round:has(> :is(svg, .icon):only-child) { width: 36px; }
}`;

// the holder to draw the button into (the same node across snapshots); order — its place among the holders of other plugins
export function fieldHolder(root, { cls = "", order = 0 } = {}) {
  if (!document.getElementById(STYLE_ID)) {
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.append(s);
  }
  let h = root.__fieldHolder;
  if (!h) {
    h = document.createElement("span");
    h.className = ("slot slot-composer-tools slot-field-tools " + cls).trim();
    h.dataset.order = String(order);
    root.__fieldHolder = h;
    root.classList.add("slot-field-root");
  }
  queueMicrotask(() => settle(root, h));   // the page puts the root into the dock after render returns
  return h;
}

// the field's bottom row of the dock the root is in, or null
const barOf = (root) => (root.isConnected ? root.closest(".dock-inner")?.querySelector("form.composer > .bar:not(.reply-bar)") : null) || null;

function settle(root, h) {
  const bar = barOf(root);
  if (h.__bar !== bar) { h.__obs?.disconnect(); h.__obs = null; h.__bar = bar; }
  if (!bar) {
    if (root.isConnected && h.parentNode !== root) root.append(h);
    return;
  }
  if (!h.__obs) {
    h.__obs = new MutationObserver(() => put(root, h));
    h.__obs.observe(bar, { childList: true });
  }
  put(root, h);
}

// into the row after the spacer, after the holders of a lower order and before the field's buttons; idempotent (its own insert wakes the
// observer once more and changes nothing)
function put(root, h) {
  const bar = h.__bar;
  if (!root.isConnected || !bar?.isConnected) {   // another session or the dock was rebuilt: the next render places it anew
    h.__obs?.disconnect();
    h.__obs = null;
    h.__bar = null;
    if (h.parentNode && h.parentNode !== root) h.remove();
    return;
  }
  const me = Number(h.dataset.order);
  const spacer = bar.querySelector(":scope > .spacer");
  let at = spacer ? spacer.nextElementSibling : bar.firstElementChild;
  while (at && (at === h || (at.classList.contains("slot-field-tools") && Number(at.dataset.order) <= me))) at = at.nextElementSibling;
  if (h.parentNode === bar && h.nextElementSibling === at) return;
  bar.insertBefore(h, at);
}
