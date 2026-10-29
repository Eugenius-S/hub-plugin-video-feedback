# Video feedback: an Agents Hub plugin

Give the hub feedback as a video: you show things on the screen and talk, and the hub works out by itself what is wrong and what you want.

## How it works

1. Press the camera next to the microphone in the input field and pick a screen or a window.
2. After 3 seconds the screen and voice recording starts and the time runs on the icon. You can stop with the same icon or with the "Stop sharing" button in the browser bar. After 10 minutes the recording stops by itself. Said the wrong thing - the bin next to the icon deletes the recording, nothing goes to the chat.
3. The hub splits the speech into phrases and takes a screen frame every half second (even if the screen did not change). One chat message carries the phrases and up to 12 main frames as pictures (at the start of each phrase), and all the frames go as a zip archive (in parts up to 18 MB, a frame is named by its timecode). The session unpacks the archive, assembles the feedback by points and deletes the archive.

The screen video itself (250 kbit/s, 10 minutes is about 19 MB) always arrives too: as the file `screen-video.webm`, in parts up to 18 MB if it is long; the path is in the message. The session watches the video for the review and deletes the file (and all the parts) afterwards. If the phrases have no text (voice is not set up, or an error), the recording audio goes to the hub as well, before transcription: `hub voice transcribe --remove <audio>` (the path is in the message) transcribes it and deletes the file.

Until the hub accepts the message, the phrases, frames, audio and screen video are kept in the browser (IndexedDB of this tab, written to disk at once, so they survive even a power-off). If the hub restarted during sending, sending is retried for up to 5 minutes. If the page was reloaded or closed, after loading it sends the recording by itself when the same chat is opened; a recording cut off in the middle goes with its audio and screen video. The video is not lost when the hub restarts in the middle of an upload either: each part is retried until the hub accepts it; if the hub did not answer for longer than the retries, the recording stays in the browser and is sent on the next visit (after three such visits the message goes without the video). After delivery all of this is erased from the browser. While a recording or sending is in progress, the page does not reload itself for a new hub version, and leaving it makes the browser ask.

## Pen island and animation tags

While you record, a small island sits at the top of the screen (drag it by the six-dot grip; it comes back where you left it). It has a pencil, a line, a rectangle, an oval, a Motion Gallery button and "close". Pick a tool and draw straight on the screen: the strokes are in the video and fade out after a few seconds. Press the same tool again (or Escape) to put it down, and clicks go to the page again. The ink is white and drawn with inversion (`mix-blend-mode: difference`), so it stays visible on light and on dark backgrounds. The island follows the hub theme (dark or light) and uses its icons. "Close" hides the island and clears the drawing; the pen button next to the bin brings it back.

If the Motion Gallery plugin is installed and running, the island shows its button: search an animation, click it, and a tag is tied to that moment of the video. The session gets the tag with the timecode and a frame (`Animation tags: ...` in the message) and knows where to put that animation. "Undo" in the toast takes the tag back. The gallery is only read, and only from a local page (it is asked on the hub port + 12); nothing is sent anywhere.

Leaving the island out of the video works only when you share a browser tab (Element Capture, Chrome 132 or newer): the video is cropped to the page, and the island is not in it. If you share the whole screen or a window, the island is in the video together with everything else.

## Language

The plugin's texts - the button hints, banners and the message sent to the session - are in English by default and in Russian when the hub language is Russian. The message keeps the same format in both languages (`[Image #N]` marks, timecodes, file paths and the `hub voice transcribe` command).

## Tokens

Video feedback spends noticeably more tokens than text. A minute of recording comes to about 5-10 thousand tokens, while the same words as text are about 400 a minute. Do not overuse it: if a couple of lines are enough, write them. Video is for when showing is easier than describing.

## Install

Settings -> Plugins -> paste the link to this repository -> "Check and install". Required:

- a hub with the `composer.tools` slot (a button in the input field) - an addition to the Plugin API, not in the common hub yet: without it the icon does not appear;
- the hub's Voice module (`voice.cmd` in hub.json) - the same one the microphone uses; if it is not set up, the hub sets up speech transcription by itself when the plugin is installed (`"needs": ["voice"]`, `hub voice setup`), and while it is being installed only frames go out;
- Chrome or Edge on a computer (a phone cannot record the screen, so there is no icon either). On macOS the browser needs the "Screen Recording" permission once, in "Privacy & Security".

## Internals

The voice is recorded in pieces that are cut at pauses: when a phrase ends it goes to recognition at once, in `/api/voice`, while the recording goes on, two phrases at a time; after the stop the page and the tab title show how many phrases are transcribed ("3 of 60"), so a slow local recognizer does not look like a lost recording. Every half second the page takes a screen frame - unconditionally, even if the screen did not change (4 minutes of recording is about 480 frames). A frame is a JPEG up to 1280 px on the long side, quality 0.6: text is readable and the archive does not bloat (frames sit in IndexedDB until delivery, 60-150 KB each). 0.4 s after a phrase starts there is one more frame: it goes to the chat first, as a picture. The recording clock runs in a separate thread (`tick.js`): the browser throttles a hub tab that is out of sight.

## Tests

`python3 -m unittest discover -s tests` - the manifest and the logic (`node --test`), with no hub and no browser; plus a recording in a real headless Chrome (a canvas instead of the screen, an oscillator instead of the microphone, a fake hub, a hub restart in the middle of an upload): `node tests/e2e/run.mjs [normal|restartMidSend|reloadMidRecording|russian|drawTools|ink|closePen|place|theme|tagMg|noGallery|confine]`. Chrome comes from `VF_CHROME` or the usual places; without it the test is skipped. The e2e uses its own throwaway Chrome profile and a random debugging port.

Icon — [3D Fluency](https://icons8.com/icons/3d-fluency) by Icons8.
