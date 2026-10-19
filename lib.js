// Видео-фидбэк: чистая логика без браузера — фразы по паузам в голосе, выбор кадров, текст сообщения.
// main.js кормит её замерами (громкость, отпечаток экрана) и делает то, что она решила.

export const VOICE = {
  floor: 0.012,       // тише этого — тишина при любом шуме
  over: 3,            // речь — громче фона в столько раз
  pause: 900,         // столько тишины после речи — фраза кончилась
  maxPhrase: 45e3,    // длиннее не бывает: режем
  idle: 20e3,         // тишина без речи — запись куска заново, чтобы не копить пустое
  onset: 400,         // кадр — через столько после начала фразы: экран уже тот, о котором речь
};
// кадр — каждые every мс безусловно (владелец 19.10: на 4 мин записи 62 кадра — «капец как мало», нужен раз в полсекунды);
// в чат картинками — max лучших, все — архивом
export const FRAMES = { max: 12, every: 500, part: 18 * 1024 * 1024 };
export const MAX_MS = 10 * 60e3;

// Фразы. step(t, rms) → что сделать сейчас: {cut: фраза или null, restart, frame: "onset" | null}.
// Кусок записи идёт непрерывно и режется только в тишине — первый слог не теряется.
export function phrases(v = VOICE) {
  let floor = null, start = 0, speechAt = null, lastSpeech = 0, onsetTaken = false;
  return {
    begin(t) { start = t; speechAt = null; onsetTaken = false; },
    step(t, rms) {
      if (floor == null) floor = Math.min(rms, v.floor);
      const speaking = rms > Math.max(v.floor, floor * v.over);
      // фон: вниз сразу, вверх — в тишине быстро, под речью еле-еле (иначе долгая фраза сама стала бы «фоном»)
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
        out.restart = true;   // пустой кусок выбросить
        this.begin(t);
      }
      return out;
    },
    // запись остановили: недоговорённая фраза — тоже фраза
    finish(t) { return speechAt != null ? { from: start, speech: speechAt, to: t } : null; },
    speaking: () => speechAt != null,
  };
}

// кадры: [{t, kind: "onset" | "tick", phrase}] → не больше max картинками; сначала начала фраз (длинные фразы важнее),
// оставшиеся места — кадры ровно по всей записи (остальное — в архиве)
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

// 1 фраза, 3 кадра, 5 кадров
export function count(n, [one, few, many]) {
  const d = n % 10, h = n % 100;
  return `${n} ${d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many}`;
}

// «Отправлено: 5 фраз, 3 кадра»; нулевое не пишем
export function sentSummary(phrasesN, framesN) {
  const parts = [phrasesN && count(phrasesN, ["фраза", "фразы", "фраз"]), framesN && count(framesN, ["кадр", "кадра", "кадров"])];
  return "Отправлено: " + parts.filter(Boolean).join(", ");
}

// имя кадра в архиве — таймкод ч-мм-сс.д (десятые секунды; сортируется по времени), в ту же десятую второй — с номером
export function frameName(t, seen) {
  const d = Math.max(0, Math.floor(t / 100));
  const s = Math.floor(d / 10);
  const base = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((x, i) => (i ? String(x).padStart(2, "0") : x)).join("-") + `.${d % 10}`;
  let name = `${base}.jpg`;
  for (let k = 2; seen.has(name); k++) name = `${base}-${k}.jpg`;
  seen.add(name);
  return name;
}

// [{size}] → группы по порядку, в каждой не больше limit (вложение хаба — до 20 МБ); больший один — сам по себе
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

// zip без сжатия (JPEG всё равно не жмётся): [{name, data: Uint8Array}] → Uint8Array; открывает любой unzip
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
    h.setUint16(4, 20, true); h.setUint16(6, 0x800, true);   // версия 2.0, имена в UTF-8
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

// текст сообщения: фразы по времени, у каждой — метки её кадров ([Image #N] — как вставленные картинки поля ввода)
export function message({ length, phrases: list, frames, voice, audio, cut, video, archive }) {
  const head = `Видео-фидбэк, ${clock(length)}. ${video?.length ? "Видео экрана — путь внизу" : "Видео не сохранилось"}, ниже мои слова по фразам и кадры экрана в эти `
    + "моменты. Собери из этого мой фидбэк по пунктам: что не так и что я хочу.";
  const lines = [];
  let n = 0;
  const label = new Map(frames.map((f) => [f, `[Image #${++n}]`]));
  list.forEach((p, i) => {
    const mine = frames.filter((f) => f.phrase === i).map((f) => label.get(f));
    const said = p.text ? `«${p.text}»` : voice ? "(неразборчиво)" : "(без расшифровки)";
    lines.push(`${clock(p.speech)} ${said}${mine.length ? " " + mine.join(" ") : ""}`);
  });
  const loose = frames.filter((f) => f.phrase == null || f.phrase >= list.length).map((f) => `${clock(f.t)} ${label.get(f)}`);
  const tail = [];
  if (!list.length) tail.push(voice ? "Голоса в записи нет, только кадры." : "Расшифровка голоса в хабе не настроена, есть только кадры.");
  else if (!voice) tail.push("Расшифровка голоса в хабе не настроена, фразы без текста.");
  if (archive?.paths?.length) tail.push(`Все ${count(archive.count, ["кадр", "кадра", "кадров"])} записи (каждые полсекунды; `
    + `имя — таймкод ч-мм-сс.д, десятые секунды) — ${archive.paths.length > 1 ? "архивы" : "архив"} ${archive.paths.map((x) => `\`${x}\``).join(", ")}. `
    + "Распакуй во временную папку (`python -m zipfile -e <архив> <папка>`), смотри кадры на отрезке каждой фразы и между ними — "
    + "там указания, которых нет в картинках выше. Разобрал — удали архив и папку.");
  if (cut) tail.push("Запись оборвалась: страница закрылась или обновилась посреди неё, договорённое после последней фразы есть только в звуке.");
  if (audio) tail.push(`${cut ? "Звук" : "Текста фраз нет, звук"} записи сохранён: \`${audio}\`. Расшифруй его — \`hub voice transcribe --remove "${audio}"\` `
    + "(файл удалится после расшифровки) — и разбери по тем же таймкодам.");
  if (video?.length) tail.push(video.length > 1
    ? `Видео экрана сохранено частями (по порядку, склей байт в байт в один .webm): ${video.map((v) => `\`${v}\``).join(", ")}.`
    : `Видео экрана сохранено: \`${video[0]}\`.`);
  return [head, "", ...lines, ...loose, ...(tail.length ? ["", ...tail] : [])].join("\n");
}
