"""The "Video feedback" plugin: manifest, script checks, languages and the logic (node --test). Standard library, no hub.
Run: python3 -m unittest discover -s tests"""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CYR = re.compile("[" + chr(0x400) + "-" + chr(0x4ff) + "]")   # any Cyrillic letter


def read(name):
    with open(os.path.join(ROOT, name), encoding="utf-8") as f:
        return f.read()


def node_eval(lang, code):
    """Run `code` (a JS expression) in node against strings.js and lib.js; the result comes back as JSON.
    `L` is the language under test."""
    url = lambda name: json.dumps("file:///" + os.path.join(ROOT, name).replace(os.sep, "/"))
    prog = (f"import {{ STR, tr, langOf }} from {url('strings.js')};"
            f"import {{ message, sentSummary }} from {url('lib.js')};"
            f"const L = {json.dumps(lang)};"
            f"console.log(JSON.stringify({code}));")
    r = subprocess.run(["node", "--input-type=module", "-e", prog], capture_output=True, text=True, encoding="utf-8")
    if r.returncode:
        raise AssertionError(r.stderr)
    return json.loads(r.stdout)


class Manifest(unittest.TestCase):
    def test_manifest_is_complete(self):
        man = json.loads(read("hub-plugin.json"))
        self.assertEqual((man["name"], man["web"]), ("video-feedback", "main.js"))
        for key in ("icon", "description", "why", "version", "hub"):
            self.assertTrue(str(man.get(key) or "").strip(), key)
        for key in ("icon", "web"):
            self.assertTrue(os.path.isfile(os.path.join(ROOT, man[key])), man[key])

    def test_manifest_is_english_with_a_russian_translation(self):
        man = json.loads(read("hub-plugin.json"))
        for key in ("description", "why"):
            self.assertFalse(CYR.search(man[key]), key)                    # the base text is English
            self.assertTrue(CYR.search(man["i18n"]["ru"][key]), key)       # the Russian text is in i18n.ru


class Source(unittest.TestCase):
    def test_video_is_kept_only_until_delivery(self):
        # the video does not pile up on disk: the video and everything else sit in the tab's IndexedDB (strict, survives
        # a power cut) until delivery is confirmed, then they are erased
        js = read("main.js")
        self.assertEqual(js.count("new MediaRecorder("), 1)            # one recorder for voice and screen
        self.assertIn("new MediaRecorder(stream", js)
        self.assertIn("piece(r.screen,", js)
        self.assertIn('durability: "strict"', js)
        self.assertIn("await forget(job.id)", js)                      # erase after delivery
        self.assertIn("data-hub-hold", js)                             # the page does not reload in the middle of a recording
        self.assertIn("vf-trash", js)                                  # the bin: delete, do not send
        self.assertIn('"composer.tools"', js)                          # the icon is in the input field, next to the microphone
        self.assertIn("const COUNT = 3", js)                           # recording starts in 3 seconds
        self.assertIn('"/api/voice"', js)                              # the hub's Voice module recognizes the speech
        self.assertIn('new Worker(hubRef.url("tick.js"))', js)         # the clock is not a tab timer (those get throttled)
        self.assertNotIn("fresh(", js)                                 # a frame every 500 ms unconditionally, no screen comparison

    def test_video_is_always_sent(self):
        # Oct 19: 0.3-0.5 sent the video only for an interrupted recording; after a normal stop the text said the video was not saved
        js = read("main.js")
        self.assertNotIn("!job.stopped && job.video", js)
        self.assertIn("if (job.video?.size && !sent.videoDone)", js)    # the video goes for a stopped recording too
        self.assertIn("video: screen?.size ? screen : null", js)        # it reaches delivery whole, not as an empty piece
        self.assertNotIn("memory: false", js)                          # video chunks pile up in memory, not only in IndexedDB
        self.assertIn("VIDEO_TRIES", js)                               # a hub refusal does not lose the video at once: the recording waits for the next visit

    def test_pen_island_is_outside_the_recorded_body_and_the_gallery_is_only_read(self):
        # the island sits outside <body> so a tab capture can crop it out of the video; Motion Gallery is only read, locally
        main, isl = read("main.js"), read("island.js")
        self.assertIn("RT.fromElement(document.body)", main)   # Element Capture: the island is not in the video
        self.assertIn("documentElement.append(root)", isl)                    # a child of <html>, not of <body>
        self.assertIn('hostname !== "localhost"', main)                       # the gallery is asked only from a local page
        self.assertIn("/gallery.json", main)
        self.assertNotIn("method:", main[main.index("async function gallery()"):main.index("async function gallery()") + 700])  # a plain GET
        self.assertNotIn("innerHTML", isl)                                    # gallery titles go in as text, not markup
        for call in ('o.t("draw_" + id)', 'o.t("draw_close")', 'o.t("tag_mg")', 'o.t("tag_search")'):
            self.assertIn(call, isl)                                          # every island label goes through t()

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_recording_in_headless_chrome(self):
        # a real recording: the video arrives as a file after a normal stop and when the hub restarted in the middle of an upload
        r = subprocess.run(["node", os.path.join(ROOT, "tests", "e2e", "run.mjs")], capture_output=True, text=True, timeout=600)
        if r.returncode == 77:
            self.skipTest("no Chrome")
        self.assertEqual(r.returncode, 0, r.stdout[-3000:] + r.stderr[-1000:])

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_scripts_parse_and_logic_holds(self):
        for name in ("main.js", "lib.js", "island.js", "tick.js", "strings.js"):
            r = subprocess.run(["node", "--check", os.path.join(ROOT, name)], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
        r = subprocess.run(["node", "--test", os.path.join(ROOT, "tests", "lib.test.mjs")], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout[-2000:])

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_zip_opens_with_the_standard_tools(self):
        # the session unpacks the frame archive with `python -m zipfile -e`: it must open with the plain zipfile
        import tempfile, zipfile
        out = os.path.join(tempfile.mkdtemp(), "f.zip")
        # a non-ASCII payload (the Russian word for "frame", by code points) checks the UTF-8 handling
        js = ("import { zip } from %s; import { writeFileSync } from 'node:fs';"
              "const f = [{ name: '0-00-01.jpg', data: new Uint8Array(3000).map((_, i) => i * 7) }, "
              "{ name: '0-00-02.jpg', data: new TextEncoder().encode('\\u043a\\u0430\\u0434\\u0440') }];"
              "writeFileSync(%s, zip(f));") % (json.dumps("file:///" + os.path.join(ROOT, "lib.js").replace(os.sep, "/")), json.dumps(out))
        r = subprocess.run(["node", "--input-type=module", "-e", js], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        with zipfile.ZipFile(out) as z:
            self.assertIsNone(z.testzip())
            self.assertEqual(z.namelist(), ["0-00-01.jpg", "0-00-02.jpg"])
            self.assertEqual(z.read("0-00-02.jpg").decode(), "кадр")


class Languages(unittest.TestCase):
    """UI strings and the message to the session: en by default, ru for a Russian hub; picked at use time by hub.lang."""

    def test_russian_text_only_in_the_ru_table(self):
        for name in ("main.js", "lib.js", "island.js", "tick.js", "style.css", "README.md", "tests/e2e/harness.html"):
            self.assertFalse(CYR.search(read(name)), name)
        js = read("strings.js")
        head, ru = js.split("\n  ru: {", 1)                           # everything before the ru table is English
        self.assertFalse(CYR.search(head))
        self.assertTrue(CYR.search(ru))

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_every_key_in_both_languages(self):
        self.assertEqual(node_eval("en", "Object.keys(STR.en).sort()"), node_eval("en", "Object.keys(STR.ru).sort()"))

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_other_languages_fall_back_to_english(self):
        for lang in ("en", "de", "uk", "xx", ""):
            self.assertEqual(node_eval(lang, 'tr(L, "say_rec")'), "Stop and send", lang)
            self.assertEqual(node_eval(lang, "langOf(L)"), "en", lang)
            self.assertTrue(node_eval(lang, "message({ length: 5000, voice: true, frames: [], phrases: [], lang: L })")
                            .startswith("Video feedback, 0:05."), lang)
            self.assertEqual(node_eval(lang, "sentSummary(2, 1, L)"), "Sent: 2 phrases, 1 frame", lang)

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_russian_hub_gets_the_russian_texts(self):
        self.assertEqual(node_eval("ru", 'tr(L, "say_rec")'), "Остановить и отправить")
        self.assertEqual(node_eval("ru", 'tr(L, "not_sent", { err: "x" })'),
                         "Не отправилось: x. Запись осталась в браузере, отправлю снова, когда откроете этот чат")
        self.assertEqual(node_eval("ru", "sentSummary(5, 3, L)"), "Отправлено: 5 фраз, 3 кадра")
        self.assertTrue(node_eval("ru", "message({ length: 5000, voice: true, frames: [], phrases: [], lang: L })")
                        .startswith("Видео-фидбэк, 0:05. Видео не сохранилось, ниже мои слова"))

    def test_language_is_read_at_use_time(self):
        js = read("main.js")
        self.assertIn("hubRef?.lang", js)                              # read on every call, not once at module load
        self.assertNotRegex(js, r"const \w+ = hubRef\?\.lang")         # not frozen into a constant
        self.assertNotRegex(js, r"const \w+ = hub\.lang")
        self.assertEqual(len(re.findall(r"lang: lang\(\)", js)), 1)    # the message to the session gets the language at sending time

    def test_no_stray_literal_texts_left_in_main(self):
        # every banner, hint and error goes through t()/tr(): no user-visible English literal is left in main.js
        js = read("main.js")
        for text in ("Not sent", "Stop and send", "Recording deleted", "No access to the microphone"):
            self.assertNotIn(text, js)


if __name__ == "__main__":
    unittest.main()
