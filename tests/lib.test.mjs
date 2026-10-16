// Логика видео-фидбэка без браузера: фразы по паузам, кадры, текст сообщения. Запуск: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { FRAMES, VOICE, changed, clock, count, diff, message, phrases, pick, sentSummary } from "../lib.js";

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

test("кадр смены — экран сменился и встал; почти тот же экран — не кадр", () => {
  const a = new Uint8Array(576).fill(10), b = new Uint8Array(576).fill(200);
  assert.equal(diff(a, a), 0);
  assert.ok(changed(b, b, a));          // сменился и стоит
  assert.ok(!changed(b, a, a));         // ещё едет
  assert.ok(!changed(a, a, a));
  assert.ok(FRAMES.same < FRAMES.changed);
});

test("кадров не больше max: сначала начала фраз, длинные важнее; по времени", () => {
  const frames = [
    { t: 100, kind: "change", phrase: 0 }, { t: 200, kind: "onset", phrase: 0 },
    { t: 300, kind: "onset", phrase: 1 }, { t: 400, kind: "onset", phrase: 2 }, { t: 500, kind: "change", phrase: 2 },
  ];
  assert.deepEqual(pick(frames, [1000, 9000, 500], 3).map((f) => f.t), [200, 300, 400]);
  assert.deepEqual(pick(frames, [1000, 9000, 500], 2).map((f) => f.t), [200, 300]);
  assert.equal(pick(frames, [], 12).length, 5);
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
});

test("итог отправки — с формами слов, нулевое не пишется", () => {
  assert.equal(sentSummary(5, 3), "Отправлено: 5 фраз, 3 кадра");
  assert.equal(sentSummary(1, 21), "Отправлено: 1 фраза, 21 кадр");
  assert.equal(sentSummary(0, 4), "Отправлено: 4 кадра");
  assert.deepEqual([11, 12, 14, 22, 25, 111].map((n) => count(n, ["кадр", "кадра", "кадров"])),
    ["11 кадров", "12 кадров", "14 кадров", "22 кадра", "25 кадров", "111 кадров"]);
});
