// Video feedback: pure logic with no browser — phrases by voice pauses, frame choice, the message text.
// main.js feeds it measurements (loudness, screen fingerprint) and does what it decided.
import { tr } from "./strings.js";

export const VOICE = {
  floor: 0.012,       // quieter than this is silence whatever the noise
  over: 3,            // speech is this many times louder than the background
  pause: 900,         // this much silence after speech: the phrase is over
  maxPhrase: 45e3,    // never longer than this: cut
  idle: 20e3,         // silence with no speech: restart the piece so as not to pile up emptiness
  onset: 400,         // the frame comes this long after the phrase begins: the screen is already the one being talked about
};
// a frame every `every` ms unconditionally;
// the chat gets `max` best ones as pictures, all of them go in the archive
export const FRAMES = { max: 12, every: 500, part: 18 * 1024 * 1024 };
export const MAX_MS = 10 * 60e3;

// Phrases. step(t, rms) -> what to do now: {cut: a phrase or null, restart, frame: "onset" | null}.
// A piece of the recording runs continuously and is cut only in silence, so the first syllable is not lost.
export function phrases(v = VOICE) {
  let floor = null, start = 0, speechAt = null, lastSpeech = 0, onsetTaken = false;
  return {
    begin(t) { start = t; speechAt = null; onsetTaken = false; },
    step(t, rms) {
      if (floor == null) floor = Math.min(rms, v.floor);
      const speaking = rms > Math.max(v.floor, floor * v.over);
      // background: down at once, up quickly in silence, barely at all under speech (otherwise a long phrase would become "background")
      floor = rms < floor ? rms : floor + (rms - floor) * (speaking ? 0.002 : 0.05);
      const out = { cut: null, restart: false, frame: null };
      if (speaking) {
        if (speechAt == null) speechAt = t;
        lastSpeech = t;
      }
      if (speechAt != null && !onsetTaken && t - speechAt >= v.onset) { onsetTaken = true; out.frame = "onset"; }
      const ended = speechAt != null && (t - lastSpeech >= v.pause || t - speechAt >= v.maxPhrase);
      if (ended) {
        out.cut = { from: start, speech: speechAt, to: t };
        out.restart = true;
        this.begin(t);
      } else if (speechAt == null && t - start >= v.idle) {
        out.restart = true;   // throw the empty piece away
        this.begin(t);
      }
      return out;
    },
    // the recording was stopped: a half-said phrase is a phrase too
    finish(t) { return speechAt != null ? { from: start, speech: speechAt, to: t } : null; },
    speaking: () => speechAt != null,
  };
}

// frames: [{t, kind: "onset" | "tick", phrase}] -> at most max as pictures; phrase starts first (long phrases matter more),
// the remaining places go to frames spread evenly over the whole recording (the rest is in the archive)
export function pick(frames, lengths, max = FRAMES.max) {
  const byT = (a, b) => a.t - b.t;
  const onsets = frames.filter((f) => f.kind === "onset")
    .sort((a, b) => (lengths[b.phrase] || 0) - (lengths[a.phrase] || 0) || byT(a, b)).slice(0, max);
  const rest = frames.filter((f) => f.kind !== "onset").sort(byT);
  const room = Math.min(max - onsets.length, rest.length);
  const spread = room <= 0 ? [] : room === 1 ? [rest[0]]
    : Array.from({ length: room }, (_, i) => rest[Math.round((i * (rest.length - 1)) / (room - 1))]);
  return [...onsets, ...spread].sort(byT);
}

// "1 phrase, 3 frames, 5 frames": forms is [one, many] (en) or [one, few, many] (ru)
export function count(n, forms) {
  if (forms.length < 3) return `${n} ${n === 1 ? forms[0] : forms[forms.length - 1]}`;
  const [one, few, many] = forms;
  const d = n % 10, h = n % 100;
  return `${n} ${d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many}`;
}

// "Sent: 5 phrases, 3 frames"; a zero is not written
export function sentSummary(phrasesN, framesN, lang) {
  const parts = [phrasesN && count(phrasesN, tr(lang, "phrase_forms")), framesN && count(framesN, tr(lang, "frame_forms"))];
  return tr(lang, "sent", { parts: parts.filter(Boolean).join(", ") });
}

// frame name in the archive: timecode h-mm-ss.t (tenths of a second; sorts by time), within the same tenth - with a number
export function frameName(t, seen) {
  const d = Math.max(0, Math.floor(t / 100));
  const s = Math.floor(d / 10);
  const base = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((x, i) => (i ? String(x).padStart(2, "0") : x)).join("-") + `.${d % 10}`;
  let name = `${base}.jpg`;
  for (let k = 2; seen.has(name); k++) name = `${base}-${k}.jpg`;
  seen.add(name);
  return name;
}

// [{size}] -> groups in order, each at most limit (a hub attachment is up to 20 MB); a bigger single one goes on its own
export function bundles(items, limit) {
  const out = [];
  let cur = [], sum = 0;
  for (const x of items) {
    if (cur.length && sum + x.size > limit) { out.push(cur); cur = []; sum = 0; }
    cur.push(x);
    sum += x.size;
  }
  if (cur.length) out.push(cur);
  return out;
}

// zip without compression (JPEG does not compress anyway): [{name, data: Uint8Array}] -> Uint8Array; any unzip opens it
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(d) {
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function zip(files) {
  const enc = new TextEncoder(), parts = [], dir = [];
  let off = 0;
  const head = (sig, n) => { const b = new DataView(new ArrayBuffer(n)); b.setUint32(0, sig, true); return b; };
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const h = head(0x04034b50, 30);
    h.setUint16(4, 20, true); h.setUint16(6, 0x800, true);   // version 2.0, names in UTF-8
    h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true); h.setUint16(26, name.length, true);
    const c = head(0x02014b50, 46);
    c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true);
    c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true); c.setUint16(28, name.length, true);
    c.setUint32(42, off, true);
    parts.push(new Uint8Array(h.buffer), name, f.data);
    dir.push(new Uint8Array(c.buffer), name);
    off += 30 + name.length + size;
  }
  const dirSize = dir.reduce((s, x) => s + x.length, 0);
  const e = head(0x06054b50, 22);
  e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, dirSize, true); e.setUint32(16, off, true);
  const all = [...parts, ...dir, new Uint8Array(e.buffer)];
  const out = new Uint8Array(all.reduce((s, x) => s + x.length, 0));
  let at = 0;
  for (const x of all) { out.set(x, at); at += x.length; }
  return out;
}

export const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// Message text (the session reads it), in the hub language: phrases by time, each with the marks of its frames
// ([Image #N], like the pictures pasted into the input field). The format is the same in every language.
export function message({ length, phrases: list, frames, voice, audio, cut, video, archive, lang }) {
  const t = (key, vars) => tr(lang, key, vars);
  const head = t("head", { len: clock(length), video: t(video?.length ? "head_video" : "head_novideo") });
  const lines = [];
  let n = 0;
  const label = new Map(frames.map((f) => [f, `[Image #${++n}]`]));
  list.forEach((p, i) => {
    const mine = frames.filter((f) => f.phrase === i).map((f) => label.get(f));
    const said = p.text ? t("said", { text: p.text }) : t(voice ? "unclear" : "no_text");
    lines.push(`${clock(p.speech)} ${said}${mine.length ? " " + mine.join(" ") : ""}`);
  });
  const loose = frames.filter((f) => f.phrase == null || f.phrase >= list.length).map((f) => `${clock(f.t)} ${label.get(f)}`);
  const tail = [];
  if (!list.length) tail.push(t(voice ? "no_voice" : "voice_off_frames"));
  else if (!voice) tail.push(t("voice_off_phrases"));
  if (archive?.paths?.length) tail.push(t("archive", { frames: count(archive.count, tr(lang, "frame_forms")),
    kind: t(archive.paths.length > 1 ? "archive_many" : "archive_one"), paths: archive.paths.map((x) => `\`${x}\``).join(", ") }));
  if (cut) tail.push(t("cut"));
  if (audio) tail.push(t(cut ? "audio_cut" : "audio_nophrases", { path: audio }));
  if (video?.length) tail.push(video.length > 1
    ? t("video_parts", { paths: video.map((v) => `\`${v}\``).join(", ") })
    : t("video_one", { path: video[0] }));
  return [head, "", ...lines, ...loose, ...(tail.length ? ["", ...tail] : [])].join("\n");
}
