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
export const FRAMES = { max: 12, changed: 0.06, same: 0.02, settled: 0.02 };
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

// отпечаток экрана — яркость 32×18; разница — доля от 0 до 1
export function diff(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length / 255;
}

// экран сменился и уже не двигается — пора снять кадр (во время фразы)
export function changed(sig, prevSig, keptSig, f = FRAMES) {
  return diff(sig, keptSig) > f.changed && diff(sig, prevSig) < f.settled;
}

// кадры: [{t, kind: "onset" | "change", phrase}] → не больше max; сначала начала фраз (длинные фразы важнее), потом смены
export function pick(frames, lengths, max = FRAMES.max) {
  const rank = (f) => (f.kind === "onset" ? 1e9 : 0) + (lengths[f.phrase] || 0);
  return [...frames].sort((a, b) => rank(b) - rank(a) || a.t - b.t).slice(0, max).sort((a, b) => a.t - b.t);
}

export const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// текст сообщения: фразы по времени, у каждой — метки её кадров ([Image #N] — как вставленные картинки поля ввода)
export function message({ length, phrases: list, frames, voice }) {
  const head = `Видео-фидбэк с экрана, ${clock(length)}. Видео не сохранялось: ниже — что я говорил, по фразам, `
    + "и кадры экрана в эти моменты. Вычлени из этого мой фидбэк по пунктам: что не так и что хочу.";
  const lines = [];
  let n = 0;
  const label = new Map(frames.map((f) => [f, `[Image #${++n}]`]));
  list.forEach((p, i) => {
    const mine = frames.filter((f) => f.phrase === i).map((f) => label.get(f));
    const said = p.text ? `«${p.text}»` : voice ? "(не разобрал)" : "(без расшифровки)";
    lines.push(`${clock(p.speech)} ${said}${mine.length ? " " + mine.join(" ") : ""}`);
  });
  const loose = frames.filter((f) => f.phrase == null || f.phrase >= list.length).map((f) => `${clock(f.t)} ${label.get(f)}`);
  const tail = [];
  if (!list.length) tail.push(voice ? "Голоса в записи не было — только кадры." : "Голос в хабе не настроен — только кадры.");
  else if (!voice) tail.push("Голос в хабе не настроен: фразы без расшифровки.");
  return [head, "", ...lines, ...loose, ...(tail.length ? ["", ...tail] : [])].join("\n");
}
