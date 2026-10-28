// UI strings and the text of the message sent to the session: en by default, ru when the hub language is Russian.
// The language is picked at use time (hub.lang), never at module load; any other language falls back to en.
// `{name}` placeholders are filled by tr(). A "forms" entry is the list of word forms for count().
export const STR = {
  en: {
    // button and banners
    trash: "Delete the recording, do not send",
    say_idle: "Record the screen and voice. Recording starts 3 seconds after you pick the screen",
    say_busy: "A recording is already running in another chat",
    say_count: "Recording in {n}",
    say_rec: "Stop and send",
    say_work: "Transcribing and sending…",
    transcribing: "Transcribing phrases: {done} of {all}. The recording is safe, it goes to the chat as soon as this is done",
    tab_work: "◌ {done}/{all} · transcribing",
    sending: "Sending the frames and the video to the chat…",
    screen_failed: "Could not start screen recording: {err}",
    no_mic: "No access to the microphone, recording the screen only",
    tab_title: "● {time} · recording",
    discarded: "Recording deleted, nothing was sent to the agent",
    empty_rec: "the recording has neither voice nor frames",
    video_failed: "the screen video failed to upload ({err})",
    not_sent: "Not sent: {err}. The recording stayed in the browser, I will send it again when you open this chat",
    hub_down: "The hub is not answering, retrying in {n} s. The recording is saved in the browser",
    hub_refused: "the hub did not accept it",
    resuming: "Sending the recording of {len} that a restart interrupted",
    undelivered: "There is undelivered video feedback ({list}). I will send it when you open this chat",
    // summary after sending: "Sent: 5 phrases, 3 frames"
    sent: "Sent: {parts}",
    phrase_forms: ["phrase", "phrases"],
    frame_forms: ["frame", "frames"],
    // message to the session (it reads this text)
    head: "Video feedback, {len}. {video}, below are my words by phrase and the screen frames at those moments. "
      + "Turn this into my feedback as a list of points: what is wrong and what I want.",
    head_video: "The screen video path is at the bottom",
    head_novideo: "The video was not saved",
    said: "“{text}”",
    unclear: "(unintelligible)",
    no_text: "(no transcript)",
    no_voice: "There is no voice in the recording, only frames.",
    voice_off_frames: "Voice transcription is not set up in the hub, there are only frames.",
    voice_off_phrases: "Voice transcription is not set up in the hub, the phrases have no text.",
    archive_one: "archive",
    archive_many: "archives",
    archive: "All {frames} of the recording (every half second; the name is the timecode h-mm-ss.t, tenths of a second) — "
      + "{kind} {paths}. Unpack it into a temporary folder (`python -m zipfile -e <archive> <folder>`), look at the frames "
      + "within each phrase and between them — they hold instructions that are not in the pictures above. "
      + "When done, delete the archive and the folder.",
    cut: "The recording was interrupted: the page was closed or reloaded in the middle of it, what was said after the last "
      + "phrase exists only in the audio.",
    audio_cut: "The audio of the recording is saved: `{path}`. Transcribe it — `hub voice transcribe --remove \"{path}\"` "
      + "(the file is deleted after transcription) — and go through it by the same timecodes.",
    audio_nophrases: "There is no phrase text, the audio of the recording is saved: `{path}`. Transcribe it — "
      + "`hub voice transcribe --remove \"{path}\"` (the file is deleted after transcription) — and go through it by "
      + "the same timecodes.",
    video_parts: "The screen video is saved in parts (in order, join them byte for byte into one .webm): {paths}. "
      + "When done, delete all the parts.",
    video_one: "The screen video is saved: `{path}`. When done, delete the file.",
  },
  ru: {
    trash: "Удалить запись, не отправлять",
    say_idle: "Записать экран и голос. Запись начнётся через 3 секунды после выбора экрана",
    say_busy: "Запись уже идёт в другом чате",
    say_count: "Запись через {n}",
    say_rec: "Остановить и отправить",
    say_work: "Расшифровываю и отправляю…",
    transcribing: "Расшифровываю фразы: {done} из {all}. Запись цела, уйдёт в чат, как только закончу",
    tab_work: "◌ {done}/{all} · расшифровка",
    sending: "Отправляю кадры и видео в чат…",
    screen_failed: "Не удалось включить запись экрана: {err}",
    no_mic: "Нет доступа к микрофону, пишу только экран",
    tab_title: "● {time} · запись",
    discarded: "Запись удалена, агенту ничего не ушло",
    empty_rec: "в записи нет ни голоса, ни кадров",
    video_failed: "видео экрана не загрузилось ({err})",
    not_sent: "Не отправилось: {err}. Запись осталась в браузере, отправлю снова, когда откроете этот чат",
    hub_down: "Хаб не отвечает, повторю через {n} с. Запись сохранена в браузере",
    hub_refused: "хаб не принял",
    resuming: "Досылаю запись {len}, прерванную перезапуском",
    undelivered: "Есть недоставленный видео-фидбэк ({list}). Отправлю, когда откроете этот чат",
    sent: "Отправлено: {parts}",
    phrase_forms: ["фраза", "фразы", "фраз"],
    frame_forms: ["кадр", "кадра", "кадров"],
    head: "Видео-фидбэк, {len}. {video}, ниже мои слова по фразам и кадры экрана в эти моменты. "
      + "Собери из этого мой фидбэк по пунктам: что не так и что я хочу.",
    head_video: "Видео экрана — путь внизу",
    head_novideo: "Видео не сохранилось",
    said: "«{text}»",
    unclear: "(неразборчиво)",
    no_text: "(без расшифровки)",
    no_voice: "Голоса в записи нет, только кадры.",
    voice_off_frames: "Расшифровка голоса в хабе не настроена, есть только кадры.",
    voice_off_phrases: "Расшифровка голоса в хабе не настроена, фразы без текста.",
    archive_one: "архив",
    archive_many: "архивы",
    archive: "Все {frames} записи (каждые полсекунды; имя — таймкод ч-мм-сс.д, десятые секунды) — "
      + "{kind} {paths}. Распакуй во временную папку (`python -m zipfile -e <архив> <папка>`), смотри кадры на отрезке "
      + "каждой фразы и между ними — там указания, которых нет в картинках выше. Разобрал — удали архив и папку.",
    cut: "Запись оборвалась: страница закрылась или обновилась посреди неё, договорённое после последней фразы есть только в звуке.",
    audio_cut: "Звук записи сохранён: `{path}`. Расшифруй его — `hub voice transcribe --remove \"{path}\"` "
      + "(файл удалится после расшифровки) — и разбери по тем же таймкодам.",
    audio_nophrases: "Текста фраз нет, звук записи сохранён: `{path}`. Расшифруй его — "
      + "`hub voice transcribe --remove \"{path}\"` (файл удалится после расшифровки) — и разбери по тем же таймкодам.",
    video_parts: "Видео экрана сохранено частями (по порядку, склей байт в байт в один .webm): {paths}. Разобрал — удали все части.",
    video_one: "Видео экрана сохранено: `{path}`. Разобрал — удали файл.",
  },
};

export const langOf = (lang) => (Object.hasOwn(STR, lang) ? lang : "en");

// tr(lang, key, vars): the string for the language (en when there is none), `{name}` replaced from vars
export function tr(lang, key, vars) {
  const r = STR[langOf(lang)][key] ?? STR.en[key] ?? key;
  if (typeof r !== "string") return r;   // a list of word forms
  // one pass: a value that itself contains "{x}" (a phrase, a path) is never substituted again
  return r.replace(/\{(\w+)\}/g, (m, n) => (vars && Object.hasOwn(vars, n) ? String(vars[n]) : m));
}
