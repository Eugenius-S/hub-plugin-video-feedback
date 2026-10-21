// Логика видео-фидбэка без браузера: фразы по паузам, кадры, текст сообщения. Запуск: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { FRAMES, VOICE, bundles, clock, count, frameName, message, phrases, pick, sentSummary, zip } from "../lib.js";

// громкость по времени: речь там, где [от, до)
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

test("фраза кончается паузой, кусок записи режется только в тишине", () => {
  const { out } = run([[1000, 3000], [5000, 6000]], 8000);
  const cuts = out.filter((s) => s.cut).map((s) => s.cut);
  assert.deepEqual(cuts.map((c) => [c.speech, c.to]), [[1000, 3750], [5000, 6750]]);
  assert.equal(cuts[1].from, 3750);                     // следующий кусок пишется с конца прошлого — без дыры
  assert.deepEqual(out.filter((s) => s.frame).map((s) => s.t), [1500, 5500]);   // кадр — через onset после начала фразы
});

test("короткая пауза внутри фразы её не режет; длинная фраза режется", () => {
  assert.equal(run([[1000, 2000], [2500, 4000]], 6000).out.filter((s) => s.cut).length, 1);
  // речь без пауз дольше maxPhrase: слова через короткие провалы громкости
  const words = Array.from({ length: 60 }, (_, i) => [i * 1000, i * 1000 + 750]);
  const long = run(words, 61e3).out.filter((s) => s.cut);
  assert.equal(long[0].cut.to - long[0].cut.speech, VOICE.maxPhrase);
});

test("тишина без речи — кусок начинается заново, фразы нет", () => {
  const { out } = run([], 45e3);
  assert.deepEqual(out.filter((s) => s.restart).map((s) => [s.t, !!s.cut]), [[20e3, false], [40e3, false]]);
});

test("недоговорённая фраза при остановке — тоже фраза", () => {
  const { p } = run([[1000, 9000]], 2000);
  assert.deepEqual(p.finish(2100), { from: 0, speech: 1000, to: 2100 });
  assert.equal(run([], 2000).p.finish(2100), null);
});

test("шумный фон: речь — только заметно громче него", () => {
  const p = phrases(VOICE);
  p.begin(0);
  for (let t = 0; t < 5000; t += 250) p.step(t, 0.03);   // вентилятор
  assert.equal(p.speaking(), false);
  p.step(5000, 0.2);
  assert.equal(p.speaking(), true);
});

test("кадр — каждые полсекунды безусловно: пропуска одинаковых экранов нет", () => {
  assert.equal(FRAMES.every, 500);
  assert.equal(1000 / FRAMES.every, 2);   // 250-мс часы: кадр на каждом втором тике
  assert.equal(240e3 / FRAMES.every, 480);   // 4 минуты — 480 кадров, не 62
});

test("кадров не больше max: сначала начала фраз, длинные важнее; по времени", () => {
  const frames = [
    { t: 100, kind: "tick", phrase: 0 }, { t: 200, kind: "onset", phrase: 0 },
    { t: 300, kind: "onset", phrase: 1 }, { t: 400, kind: "onset", phrase: 2 }, { t: 500, kind: "tick", phrase: 2 },
  ];
  assert.deepEqual(pick(frames, [1000, 9000, 500], 3).map((f) => f.t), [200, 300, 400]);
  assert.deepEqual(pick(frames, [1000, 9000, 500], 2).map((f) => f.t), [200, 300]);
  assert.equal(pick(frames, [], 12).length, 5);
  // без фраз (или после начал фраз) — остальные ровно по записи, не первые подряд
  const ticks = Array.from({ length: 100 }, (_, i) => ({ t: i * 1000, kind: "tick", phrase: 0 }));
  assert.deepEqual(pick(ticks, [], 4).map((f) => f.t), [0, 33000, 66000, 99000]);
});

test("сообщение: фразы по времени, у каждой её кадры метками [Image #N]", () => {
  const frames = [{ t: 1400, phrase: 0 }, { t: 5500, phrase: 1 }, { t: 6000, phrase: 1 }];
  const text = message({ length: 102e3, voice: true, frames,
    phrases: [{ speech: 1000, text: "кнопка прыгает" }, { speech: 5000, text: "" }] });
  const lines = text.split("\n");
  assert.match(lines[0], /^Видео-фидбэк, 1:42\./);
  assert.match(lines[0], /Собери из этого мой фидбэк/);
  assert.deepEqual(lines.slice(2), ["0:01 «кнопка прыгает» [Image #1]", "0:05 (неразборчиво) [Image #2] [Image #3]"]);
});

test("без голоса в хабе и без речи — сообщение говорит об этом", () => {
  assert.match(message({ length: 5000, voice: false, frames: [{ t: 0 }], phrases: [] }), /Расшифровка голоса в хабе не настроена, есть только кадры/);
  assert.match(message({ length: 5000, voice: true, frames: [{ t: 0 }], phrases: [] }), /0:00 \[Image #1\]/);
  assert.equal(clock(61400), "1:01");
});

test("звук без расшифровки: путь и как расшифровать, файл — до расшифровки", () => {
  const audio = "C:/state/attachments/ab/voice-14-50.webm";
  const text = message({ length: 5000, voice: false, frames: [], phrases: [{ speech: 0, text: "" }], audio });
  assert.match(text, /звук записи сохранён: `C:\/state\/attachments\/ab\/voice-14-50\.webm`/);
  assert.match(text, /hub voice transcribe --remove "C:\/state\/attachments\/ab\/voice-14-50\.webm"/);
  assert.doesNotMatch(text, /дней/);
  assert.doesNotMatch(message({ length: 5000, voice: true, frames: [], phrases: [{ speech: 0, text: "ок" }] }), /звук записи/);
});

test("оборванная запись (страницу обновили посреди неё): об этом сказано, звук — всегда", () => {
  const audio = "C:/state/attachments/ab/voice-14-50.webm";
  const text = message({ length: 5000, voice: true, frames: [], phrases: [{ speech: 0, text: "ок" }], audio, cut: true });
  assert.match(text, /Запись оборвалась/);
  assert.match(text, /Звук записи сохранён: `C:\/state/);
  assert.doesNotMatch(message({ length: 5000, voice: true, frames: [], phrases: [{ speech: 0, text: "ок" }] }), /оборвалась/);
});

test("оборванная запись с видео: пути видео, части — по порядку", () => {
  const one = message({ length: 5000, voice: true, frames: [], phrases: [], cut: true, video: ["C:/a/screen-video.webm"] });
  assert.match(one, /Видео экрана сохранено: `C:\/a\/screen-video\.webm`/);
  const two = message({ length: 5000, voice: true, frames: [], phrases: [], cut: true, video: ["C:/a/v-1of2.webm", "C:/a/v-2of2.webm"] });
  assert.match(two, /частями .*`C:\/a\/v-1of2\.webm`, `C:\/a\/v-2of2\.webm`/);
  assert.doesNotMatch(message({ length: 5000, voice: true, frames: [], phrases: [] }), /Видео экрана/);
  assert.match(one, /Разобрал — удали файл/);
  assert.match(two, /Разобрал — удали все части/);
});

test("много кадров: в чат — max лучших, все — архивом; путь, таймкоды и что удалить после разбора", () => {
  const frames = [{ t: 1400, phrase: 0 }];
  const text = message({ length: 270e3, voice: true, frames, phrases: [{ speech: 1000, text: "тут" }],
    archive: { paths: ["C:/a/frames-1of2.zip", "C:/a/frames-2of2.zip"], count: 230 } });
  assert.match(text, /Все 230 кадров/);
  assert.match(text, /`C:\/a\/frames-1of2\.zip`, `C:\/a\/frames-2of2\.zip`/);
  assert.match(text, /python -m zipfile -e/);
  assert.match(text, /удали/);
  assert.doesNotMatch(message({ length: 5000, voice: true, frames, phrases: [] }), /архив/);
});

test("имя кадра в архиве — таймкод, совпадения — с номером", () => {
  const seen = new Set();
  assert.deepEqual([65e3, 65400, 65450, 3725e3].map((t) => frameName(t, seen)), ["0-01-05.0.jpg", "0-01-05.4.jpg", "0-01-05.4-2.jpg", "1-02-05.0.jpg"]);
  // кадры каждые 500 мс — имена разные и в порядке времени
  const all = new Set(), sorted = Array.from({ length: 480 }, (_, i) => frameName(i * 500, all));
  assert.equal(all.size, 480);
  assert.deepEqual(sorted.slice().sort(), sorted);
  assert.equal(sorted[1], "0-00-00.5.jpg");
});

test("архивы — по размеру: каждый не больше предела, порядок сохраняется", () => {
  const items = [5, 5, 5, 9, 1].map((size, i) => ({ i, size }));
  assert.deepEqual(bundles(items, 10).map((g) => g.map((x) => x.i)), [[0, 1], [2], [3, 4]]);
  assert.deepEqual(bundles([], 10), []);
  assert.deepEqual(bundles([{ i: 0, size: 50 }], 10).map((g) => g.length), [1]);   // больше предела — один в своём
});

test("zip без сжатия: заголовки и CRC32", () => {
  const z = zip([{ name: "a.txt", data: new TextEncoder().encode("hello") }]);
  const v = new DataView(z.buffer);
  assert.equal(v.getUint32(0, true), 0x04034b50);
  assert.equal(v.getUint32(14, true), 0x3610a686);   // crc32("hello")
  assert.equal(v.getUint32(z.length - 22, true), 0x06054b50);
});

test("итог отправки — с формами слов, нулевое не пишется", () => {
  assert.equal(sentSummary(5, 3), "Отправлено: 5 фраз, 3 кадра");
  assert.equal(sentSummary(1, 21), "Отправлено: 1 фраза, 21 кадр");
  assert.equal(sentSummary(0, 4), "Отправлено: 4 кадра");
  assert.deepEqual([11, 12, 14, 22, 25, 111].map((n) => count(n, ["кадр", "кадра", "кадров"])),
    ["11 кадров", "12 кадров", "14 кадров", "22 кадра", "25 кадров", "111 кадров"]);
});
