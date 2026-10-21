// Video feedback logic without a browser: phrases by pauses, frames, the message text. Run: node --test tests/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { FRAMES, VOICE, bundles, clock, count, frameName, message, phrases, pick, sentSummary, zip } from "../lib.js";
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
  assert.deepEqual(lines.slice(2), ["0:01 “the button jumps” [Image #1]", "0:05 (unintelligible) [Image #2] [Image #3]"]);
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
  assert.match(text, /“use \{path\} and \$& here”/);
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
