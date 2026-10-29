// Video feedback logic without a browser: phrases by pauses, frames, the message text. Run: node --test tests/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { DRAW, FRAMES, INK, VOICE, bundles, clock, count, fadeAlpha, fmtDuration, frameName, geometry, inkFor, luma, matchItem,
  mediaUrl, meanLuma, message, outline, phrases, pick, sentSummary, stamp, viewToFrame, zip } from "../lib.js";
import { STR, tr } from "../strings.js";

// loudness over time: speech where [from, to)
const run = (speech, until, step = 250) => {
  const p = phrases(VOICE);
  p.begin(0);
  const out = [];
  for (let t = 0; t <= until; t += step) {
    const loud = speech.some(([a, b]) => t >= a && t < b);
    out.push({ t, ...p.step(t, loud ? 0.2 : 0.003) });
  }
  return { p, out };
};

test("a phrase ends with a pause, a piece of the recording is cut only in silence", () => {
  const { out } = run([[1000, 3000], [5000, 6000]], 8000);
  const cuts = out.filter((s) => s.cut).map((s) => s.cut);
  assert.deepEqual(cuts.map((c) => [c.speech, c.to]), [[1000, 3750], [5000, 6750]]);
  assert.equal(cuts[1].from, 3750);                     // the next piece starts where the last ended - no gap
  assert.deepEqual(out.filter((s) => s.frame).map((s) => s.t), [1500, 5500]);   // the frame comes `onset` after the phrase begins
});

test("a short pause inside a phrase does not cut it; a long phrase is cut", () => {
  assert.equal(run([[1000, 2000], [2500, 4000]], 6000).out.filter((s) => s.cut).length, 1);
  // speech with no pauses longer than maxPhrase: words with short dips in loudness
  const words = Array.from({ length: 60 }, (_, i) => [i * 1000, i * 1000 + 750]);
  const long = run(words, 61e3).out.filter((s) => s.cut);
  assert.equal(long[0].cut.to - long[0].cut.speech, VOICE.maxPhrase);
});

test("silence with no speech: the piece starts over, there is no phrase", () => {
  const { out } = run([], 45e3);
  assert.deepEqual(out.filter((s) => s.restart).map((s) => [s.t, !!s.cut]), [[20e3, false], [40e3, false]]);
});

test("a half-said phrase at stop is a phrase too", () => {
  const { p } = run([[1000, 9000]], 2000);
  assert.deepEqual(p.finish(2100), { from: 0, speech: 1000, to: 2100 });
  assert.equal(run([], 2000).p.finish(2100), null);
});

test("noisy background: speech is only what is clearly louder than it", () => {
  const p = phrases(VOICE);
  p.begin(0);
  for (let t = 0; t < 5000; t += 250) p.step(t, 0.03);   // a fan
  assert.equal(p.speaking(), false);
  p.step(5000, 0.2);
  assert.equal(p.speaking(), true);
});

test("a frame every half second unconditionally: identical screens are not skipped", () => {
  assert.equal(FRAMES.every, 500);
  assert.equal(1000 / FRAMES.every, 2);   // 250 ms clock: a frame on every second tick
  assert.equal(240e3 / FRAMES.every, 480);   // 4 minutes is 480 frames, not 62
});

test("at most max frames: phrase starts first, long ones matter more; ordered by time", () => {
  const frames = [
    { t: 100, kind: "tick", phrase: 0 }, { t: 200, kind: "onset", phrase: 0 },
    { t: 300, kind: "onset", phrase: 1 }, { t: 400, kind: "onset", phrase: 2 }, { t: 500, kind: "tick", phrase: 2 },
  ];
  assert.deepEqual(pick(frames, [1000, 9000, 500], 3).map((f) => f.t), [200, 300, 400]);
  assert.deepEqual(pick(frames, [1000, 9000, 500], 2).map((f) => f.t), [200, 300]);
  assert.equal(pick(frames, [], 12).length, 5);
  // without phrases (or after the phrase starts) the rest are spread over the recording, not the first ones in a row
  const ticks = Array.from({ length: 100 }, (_, i) => ({ t: i * 1000, kind: "tick", phrase: 0 }));
  assert.deepEqual(pick(ticks, [], 4).map((f) => f.t), [0, 33000, 66000, 99000]);
});

test("message: phrases by time, each with its frames as [Image #N] marks", () => {
  const frames = [{ t: 1400, phrase: 0 }, { t: 5500, phrase: 1 }, { t: 6000, phrase: 1 }];
  const text = message({ length: 102e3, voice: true, frames,
    phrases: [{ speech: 1000, text: "the button jumps" }, { speech: 5000, text: "" }] });
  const lines = text.split("\n");
  assert.match(lines[0], /^Video feedback, 1:42\./);
  assert.match(lines[0], /Turn this into my feedback/);
  assert.match(lines[0], /The video was not saved/);
  assert.deepEqual(lines.slice(2), ["0:01 \u201cthe button jumps\u201d [Image #1]", "0:05 (unintelligible) [Image #2] [Image #3]"]);
});

test("no voice in the hub and no speech: the message says so", () => {
  assert.match(message({ length: 5000, voice: false, frames: [{ t: 0 }], phrases: [] }), /Voice transcription is not set up in the hub, there are only frames/);
  assert.match(message({ length: 5000, voice: true, frames: [{ t: 0 }], phrases: [] }), /There is no voice in the recording, only frames/);
  assert.match(message({ length: 5000, voice: true, frames: [{ t: 0 }], phrases: [] }), /0:00 \[Image #1\]/);
  assert.match(message({ length: 5000, voice: false, frames: [], phrases: [{ speech: 0, text: "" }] }), /0:00 \(no transcript\)/);
  assert.match(message({ length: 5000, voice: false, frames: [], phrases: [{ speech: 0, text: "ok" }] }), /the phrases have no text/);
  assert.equal(clock(61400), "1:01");
});

test("audio without transcription: the path and how to transcribe it, the file goes before transcription", () => {
  const audio = "C:/state/attachments/ab/voice-14-50.webm";
  const text = message({ length: 5000, voice: false, frames: [], phrases: [{ speech: 0, text: "" }], audio });
  assert.match(text, /audio of the recording is saved: `C:\/state\/attachments\/ab\/voice-14-50\.webm`/);
  assert.match(text, /hub voice transcribe --remove "C:\/state\/attachments\/ab\/voice-14-50\.webm"/);
  assert.doesNotMatch(text, /days/);
  assert.doesNotMatch(message({ length: 5000, voice: true, frames: [], phrases: [{ speech: 0, text: "ok" }] }), /audio of the recording/);
});

test("a recording cut off (the page was reloaded in the middle): it says so, the audio is always there", () => {
  const audio = "C:/state/attachments/ab/voice-14-50.webm";
  const text = message({ length: 5000, voice: true, frames: [], phrases: [{ speech: 0, text: "ok" }], audio, cut: true });
  assert.match(text, /The recording was interrupted/);
  assert.match(text, /The audio of the recording is saved: `C:\/state/);
  assert.doesNotMatch(message({ length: 5000, voice: true, frames: [], phrases: [{ speech: 0, text: "ok" }] }), /interrupted/);
});

test("a cut-off recording with video: the video paths, parts in order", () => {
  const one = message({ length: 5000, voice: true, frames: [], phrases: [], cut: true, video: ["C:/a/screen-video.webm"] });
  assert.match(one, /The screen video is saved: `C:\/a\/screen-video\.webm`/);
  assert.match(one, /The screen video path is at the bottom/);
  assert.doesNotMatch(one, /The video was not saved/);
  const two = message({ length: 5000, voice: true, frames: [], phrases: [], cut: true, video: ["C:/a/v-1of2.webm", "C:/a/v-2of2.webm"] });
  assert.match(two, /in parts .*`C:\/a\/v-1of2\.webm`, `C:\/a\/v-2of2\.webm`/);
  assert.doesNotMatch(message({ length: 5000, voice: true, frames: [], phrases: [] }), /The screen video is saved/);
  assert.match(one, /When done, delete the file/);
  assert.match(two, /When done, delete all the parts/);
});

test("many frames: the chat gets the best max, all go in an archive; the path, timecodes and what to delete after the review", () => {
  const frames = [{ t: 1400, phrase: 0 }];
  const text = message({ length: 270e3, voice: true, frames, phrases: [{ speech: 1000, text: "here" }],
    archive: { paths: ["C:/a/frames-1of2.zip", "C:/a/frames-2of2.zip"], count: 230 } });
  assert.match(text, /All 230 frames of the recording/);
  assert.match(text, /archives `C:\/a\/frames-1of2\.zip`, `C:\/a\/frames-2of2\.zip`/);
  assert.match(text, /python -m zipfile -e/);
  assert.match(text, /delete the archive/);
  assert.doesNotMatch(message({ length: 5000, voice: true, frames, phrases: [] }), /archive/);
  const one = message({ length: 5000, voice: true, frames, phrases: [], archive: { paths: ["C:/a/frames.zip"], count: 1 } });
  assert.match(one, /All 1 frame of the recording .* archive `C:\/a\/frames\.zip`/);
});

test("a value with {placeholders} (a phrase, a path) is inserted as is, never substituted again", () => {
  const text = message({ length: 5000, voice: true, frames: [], phrases: [{ speech: 0, text: "use {path} and $& here" }], audio: "C:/a/{len}.webm", cut: true });
  assert.match(text, /\u201cuse \{path\} and \$& here\u201d/);
  assert.match(text, /saved: `C:\/a\/\{len\}\.webm`/);
});

test("frame name in the archive is a timecode, collisions get a number", () => {
  const seen = new Set();
  assert.deepEqual([65e3, 65400, 65450, 3725e3].map((t) => frameName(t, seen)), ["0-01-05.0.jpg", "0-01-05.4.jpg", "0-01-05.4-2.jpg", "1-02-05.0.jpg"]);
  // a frame every 500 ms: the names differ and go in time order
  const all = new Set(), sorted = Array.from({ length: 480 }, (_, i) => frameName(i * 500, all));
  assert.equal(all.size, 480);
  assert.deepEqual(sorted.slice().sort(), sorted);
  assert.equal(sorted[1], "0-00-00.5.jpg");
});

test("archives by size: each at most the limit, the order is kept", () => {
  const items = [5, 5, 5, 9, 1].map((size, i) => ({ i, size }));
  assert.deepEqual(bundles(items, 10).map((g) => g.map((x) => x.i)), [[0, 1], [2], [3, 4]]);
  assert.deepEqual(bundles([], 10), []);
  assert.deepEqual(bundles([{ i: 0, size: 50 }], 10).map((g) => g.length), [1]);   // over the limit: alone in its own
});

test("zip without compression: headers and CRC32", () => {
  const z = zip([{ name: "a.txt", data: new TextEncoder().encode("hello") }]);
  const v = new DataView(z.buffer);
  assert.equal(v.getUint32(0, true), 0x04034b50);
  assert.equal(v.getUint32(14, true), 0x3610a686);   // crc32("hello")
  assert.equal(v.getUint32(z.length - 22, true), 0x06054b50);
});

test("send summary: word forms, a zero is not written", () => {
  assert.equal(sentSummary(5, 3), "Sent: 5 phrases, 3 frames");
  assert.equal(sentSummary(1, 21), "Sent: 1 phrase, 21 frames");
  assert.equal(sentSummary(0, 1), "Sent: 1 frame");
  assert.equal(sentSummary(0, 4, "ru"), "Отправлено: 4 кадра");
  assert.deepEqual([11, 12, 14, 22, 25, 111].map((n) => count(n, ["кадр", "кадра", "кадров"])),
    ["11 кадров", "12 кадров", "14 кадров", "22 кадра", "25 кадров", "111 кадров"]);
  assert.deepEqual([0, 1, 2, 21].map((n) => count(n, ["frame", "frames"])), ["0 frames", "1 frame", "2 frames", "21 frames"]);
});

// ───── language: en by default, ru when the hub language is Russian ─────
test("both languages have the same keys, and the word forms lists have the right length", () => {
  assert.deepEqual(Object.keys(STR.en).sort(), Object.keys(STR.ru).sort());
  assert.equal(STR.en.frame_forms.length, 2);
  assert.equal(STR.ru.frame_forms.length, 3);
  for (const k of Object.keys(STR.en)) {   // the same {placeholders} in both
    const names = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(names(STR.ru[k]), names(STR.en[k]), k);
  }
});

test("any language but ru falls back to en", () => {
  for (const lang of ["en", "de", "uk", "xx", "", undefined, null, "toString", "__proto__"]) {
    assert.equal(tr(lang, "say_rec"), "Stop and send", String(lang));
    assert.match(message({ length: 5000, voice: true, frames: [], phrases: [], lang }), /^Video feedback, 0:05\./, String(lang));
  }
  assert.equal(tr("ru", "say_rec"), "Остановить и отправить");
  assert.equal(tr("ru", "say_count", { n: 2 }), "Запись через 2");
});

test("the message to the session in Russian: the same format, the Russian text as before", () => {
  const frames = [{ t: 1400, phrase: 0 }, { t: 5500, phrase: 1 }];
  const text = message({ length: 102e3, voice: true, frames, lang: "ru",
    phrases: [{ speech: 1000, text: "кнопка прыгает" }, { speech: 5000, text: "" }] });
  const lines = text.split("\n");
  assert.match(lines[0], /^Видео-фидбэк, 1:42\. Видео не сохранилось, ниже мои слова по фразам и кадры экрана в эти моменты\./);
  assert.match(lines[0], /Собери из этого мой фидбэк по пунктам/);
  assert.deepEqual(lines.slice(2), ["0:01 «кнопка прыгает» [Image #1]", "0:05 (неразборчиво) [Image #2]"]);
  const full = message({ length: 5000, voice: false, frames: [], lang: "ru", cut: true, audio: "/a/v.webm", video: ["/a/s.webm"],
    phrases: [], archive: { paths: ["/a/f.zip"], count: 21 } });
  assert.match(full, /Видео экрана — путь внизу/);
  assert.match(full, /Расшифровка голоса в хабе не настроена, есть только кадры/);
  assert.match(full, /Все 21 кадр записи .* — архив `\/a\/f\.zip`\. Распакуй/);
  assert.match(full, /Запись оборвалась/);
  assert.match(full, /Звук записи сохранён: `\/a\/v\.webm`\. Расшифруй его — `hub voice transcribe --remove "\/a\/v\.webm"`/);
  assert.match(full, /Видео экрана сохранено: `\/a\/s\.webm`\. Разобрал — удали файл/);
  // protocol parts do not depend on the language
  for (const lang of ["en", "ru"]) {
    const m = message({ length: 5000, voice: true, frames: [{ t: 0, phrase: 0 }], lang, phrases: [{ speech: 0, text: "x" }], audio: "/a/v.webm" });
    assert.match(m, /\[Image #1\]/);
    assert.match(m, /hub voice transcribe --remove "\/a\/v\.webm"/);
  }
});

// ───── pen island: ink colour, geometry, fading, Motion Gallery tags ─────
test("the ink adapts: white by default, dark on a light place", () => {
  assert.equal(luma(0, 0, 0), 0);
  assert.ok(Math.abs(luma(255, 255, 255) - 1) < 1e-9);
  assert.equal(inkFor(luma(0, 0, 0)), INK.light);
  assert.equal(inkFor(luma(255, 255, 255)), INK.dark);
  assert.equal(inkFor(luma(200, 200, 200)), INK.dark);    // light grey: dark ink
  assert.equal(inkFor(luma(90, 90, 160)), INK.light);     // a dark blue: white ink
});

test("meanLuma averages a square of the picture and tells when the square is outside", () => {
  const w = 4, h = 4, data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { const v = i % w < 2 ? 0 : 255; data.set([v, v, v, 255], i * 4); }   // left half black, right half white
  assert.equal(meanLuma(data, w, h, 0.5, 1.5, 0.4), 0);
  assert.ok(Math.abs(meanLuma(data, w, h, 3, 1, 0.4) - 1) < 1e-9);
  const mid = meanLuma(data, w, h, 2, 2, 1);
  assert.ok(mid > 0.3 && mid < 0.8, String(mid));
  assert.equal(meanLuma(data, w, h, 100, 100, 1), null);
});

test("geometry: where the page lies in the captured picture", () => {
  const m = { inner: { w: 1000, h: 600 }, outer: { w: 1016, h: 700 }, screen: { w: 1920, h: 1080 }, pos: { x: 100, y: 50 } };
  assert.deepEqual(geometry("browser", m), { surface: m.inner, origin: { x: 0, y: 0 } });
  assert.deepEqual(geometry(undefined, m), { surface: m.inner, origin: { x: 0, y: 0 } });   // unknown: as a tab
  assert.deepEqual(geometry("window", m), { surface: m.outer, origin: { x: 8, y: 92 } });
  assert.deepEqual(geometry("monitor", m), { surface: m.screen, origin: { x: 108, y: 142 } });
  // a point of the page in the frame: the picture is twice as big as the page
  assert.deepEqual(viewToFrame({ x: 10, y: 20 }, geometry("browser", m), { w: 2000, h: 1200 }), { x: 20, y: 40 });
  const g = geometry("monitor", m);
  assert.deepEqual(viewToFrame({ x: 0, y: 0 }, g, { w: 960, h: 540 }), { x: 54, y: 71 });
});

test("outline: points on the shape to look at the background", () => {
  const a = { x: 0, y: 0 }, b = { x: 100, y: 50 };
  assert.deepEqual(outline("pencil", a, b), [a, b]);
  const line = outline("line", a, b, 4);
  assert.equal(line.length, 4);
  assert.deepEqual(line[0], { x: 12.5, y: 6.25 });
  for (const tool of ["rect", "oval"]) {
    const pts = outline(tool, a, b, 16);
    assert.equal(pts.length, 16, tool);
    for (const p of pts) assert.ok(p.x >= -1e-9 && p.x <= 100 + 1e-9 && p.y >= -1e-9 && p.y <= 50 + 1e-9, `${tool} ${p.x},${p.y}`);
  }
  // every point of a rectangle lies on its perimeter
  for (const p of outline("rect", a, b, 16)) assert.ok(p.x === 0 || p.x === 100 || p.y === 0 || p.y === 50 || Math.abs(p.x % 1) < 1e-9, `${p.x},${p.y}`);
  assert.equal(outline("rect", a, a, 4).length, 4);        // a zero-size drag does not break
});

test("a finished stroke stays visible, then fades; hold 0 keeps it", () => {
  assert.equal(fadeAlpha(0), 1);
  assert.equal(fadeAlpha(DRAW.hold), 1);
  assert.equal(fadeAlpha(DRAW.hold + DRAW.fade / 2), 0.5);
  assert.equal(fadeAlpha(DRAW.hold + DRAW.fade), 0);
  assert.equal(fadeAlpha(1e9), 0);
  assert.equal(fadeAlpha(1e9, 0), 1);
});

test("Motion Gallery: poster address, duration, search", () => {
  assert.equal(mediaUrl("http://localhost:8799", "/media/a.png"), "http://localhost:8799/media/a.png");
  assert.equal(mediaUrl("http://localhost:8799", "https://cdn.x/a.png"), "https://cdn.x/a.png");
  for (const bad of ["javascript:alert(1)", "data:image/png;base64,AA", "//evil.example/a.png", " javascript:1"]) assert.equal(mediaUrl("http://x", bad), "", bad);
  assert.equal(mediaUrl("http://x", ""), "");
  assert.equal(fmtDuration(65), "1:05");
  assert.equal(fmtDuration(4.4), "0:04");
  assert.equal(fmtDuration(0), "");
  assert.equal(fmtDuration(undefined), "");
  const item = { slug: "bounce-in", title: "Bouncy Arrow", tags: ["Ease", "ui"] };
  assert.ok(matchItem(item, ""));
  assert.ok(matchItem(item, "arrow"));
  assert.ok(matchItem(item, "BOUNCE ease"));
  assert.ok(!matchItem(item, "arrow rocket"));
  assert.ok(matchItem({ slug: "x" }, "x"));
  assert.equal(stamp(84000), "01:24");
  assert.equal(stamp(-5), "00:00");
});

test("pick: the animation tags always get a picture, even when the frames are over", () => {
  const frames = [
    ...Array.from({ length: 6 }, (_, i) => ({ t: i * 1000, kind: "onset", phrase: i })),
    { t: 2500, kind: "tag", tag: 0 }, { t: 9000, kind: "tag", tag: 1 },
    ...Array.from({ length: 5 }, (_, i) => ({ t: 500 + i * 3000, kind: "tick" })),
  ];
  const got = pick(frames, [1, 1, 1, 1, 1, 1], 4);
  assert.equal(got.length, 4);
  assert.equal(got.filter((f) => f.kind === "tag").length, 2);
  assert.deepEqual(got.map((f) => f.t), [...got.map((f) => f.t)].sort((a, b) => a - b));
  const many = Array.from({ length: 15 }, (_, i) => ({ t: i, kind: "tag", tag: i }));
  assert.equal(pick(many, [], 12).length, 12);               // not more than the limit
});

test("message: animation tags and drawing are told to the session, an undone tag is not", () => {
  const frames = [{ t: 2500, kind: "tag", tag: 1 }, { t: 1400, phrase: 0 }];
  const tags = [{ slug: "old", title: "Old", t: 1000, gone: true }, { slug: "pop-in", title: "Pop in", t: 2500 }, { slug: "bare", t: 70e3 }];
  const text = message({ length: 80e3, voice: true, frames, tags, drew: true, lang: "en", phrases: [{ speech: 1000, text: "put it here" }] });
  const lines = text.split("\n");
  assert.ok(lines.includes("0:03 \u00b7 Motion Gallery: Pop in (pop-in) [Image #1]"), text);
  assert.ok(lines.includes("1:10 \u00b7 Motion Gallery: bare (bare)"), text);
  assert.ok(!text.includes("old"), "the undone tag is gone");
  assert.ok(lines.includes("0:01 \u201cput it here\u201d [Image #2]"), "the tag picture is not in a phrase line");
  assert.match(text, /Animation tags: /);
  assert.match(text, /I drew on the screen while recording/);
  const ru = message({ length: 80e3, voice: true, frames: [], tags: [{ slug: "pop-in", title: "Pop in", t: 2500 }], drew: true, lang: "ru", phrases: [] });
  assert.match(ru, /Теги анимаций:/);
  assert.match(ru, /Во время записи я рисовал на экране/);
  const plain = message({ length: 5000, voice: true, frames: [], phrases: [], lang: "en" });
  assert.ok(!/Animation tags|I drew on the screen/.test(plain), "no tags and no drawing: nothing extra");
  const onlyGone = message({ length: 5000, voice: true, frames: [], tags: [{ slug: "a", t: 1, gone: true }], phrases: [], lang: "en" });
  assert.ok(!onlyGone.includes("Animation tags"), "only undone tags: no note");
});
