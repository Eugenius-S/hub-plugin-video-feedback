"""Плагин «Видео-фидбэк»: манифест, разбор скриптов и логика (node --test). Стандартная библиотека, без хаба.
Запуск: python3 -m unittest discover -s tests"""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(name):
    with open(os.path.join(ROOT, name), encoding="utf-8") as f:
        return f.read()


class Manifest(unittest.TestCase):
    def test_manifest_is_complete(self):
        man = json.loads(read("hub-plugin.json"))
        self.assertEqual((man["name"], man["web"]), ("video-feedback", "main.js"))
        for key in ("icon", "description", "why", "version", "hub"):
            self.assertTrue(str(man.get(key) or "").strip(), key)
        for key in ("icon", "web"):
            self.assertTrue(os.path.isfile(os.path.join(ROOT, man[key])), man[key])


class Source(unittest.TestCase):
    def test_video_is_kept_only_until_delivery(self):
        # владелец 15.10: видео не копит диск; 16.10: «данные бесценны… и видео обязательно» — видео и всё остальное
        # лежат в IndexedDB вкладки (strict — переживает выключение света) до подтверждения доставки, потом стираются
        js = read("main.js")
        self.assertEqual(js.count("new MediaRecorder("), 1)            # один запис на голос и экран
        self.assertIn("new MediaRecorder(stream", js)
        self.assertIn("piece(r.screen,", js)
        self.assertIn('durability: "strict"', js)
        self.assertIn("await forget(job.id)", js)                      # после доставки — стереть
        self.assertIn("data-hub-hold", js)                             # страница не обновляется посреди записи
        self.assertIn("vf-trash", js)                                  # корзина: удалить, не отправлять
        self.assertIn('"composer.tools"', js)                          # значок — в поле ввода, рядом с микрофоном
        self.assertIn("const COUNT = 3", js)                           # запись — через 3 секунды
        self.assertIn('"/api/voice"', js)                              # распознаёт модуль «Голос» хаба
        self.assertIn('new Worker(hubRef.url("tick.js"))', js)         # часы — не таймер вкладки (её притормаживают)

    @unittest.skipUnless(shutil.which("node"), "нужен node")
    def test_scripts_parse_and_logic_holds(self):
        for name in ("main.js", "lib.js", "tick.js"):
            r = subprocess.run(["node", "--check", os.path.join(ROOT, name)], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
        r = subprocess.run(["node", "--test", os.path.join(ROOT, "tests", "lib.test.mjs")], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout[-2000:])


if __name__ == "__main__":
    unittest.main()
