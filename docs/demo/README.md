# Demo

A useful Auralynk demo shows one complete round trip: a message going
*into* the browser, out through the speakers, through the air, back
through the microphone, and decoded on screen with **CRC OK**.

## What is (and is not) in this folder

No demo recording is bundled with the repository. A physical acoustic
demo can only be honest if it is actually recorded — nothing here is
simulated, scripted or pre-rendered. Add your own recording to this
folder and link it from the README:

```
docs/demo/auralynk-demo.gif     (preferred — renders inline on GitHub)
docs/demo/auralynk-demo.mp4     (acceptable for longer captures)
```

## Recording one

1. Run `npm install && npm run dev` and open `http://localhost:5173`.
2. Start a screen recorder (OBS, Xbox Game Bar, `ffmpeg -f gdigrab`,
   or the browser's own recorder).
3. Show the seven beats of the story:
   1. the Auralynk interface (hero + transmitter/receiver panels),
   2. entering a message,
   3. pressing **TRANSMIT MESSAGE** — the progress and symbol count,
   4. the speaker / open air between the two devices (camera or
      second window if you want to show the physical path),
   5. the receiver running — live spectrum, input level, detected bit,
   6. the decoded message appearing,
   7. the **CRC OK** badge.
4. Keep it short (15–30 s), keep the audio on — the transmitted
   chirp *is* the demo — and trim the dead air.

## Physical demo checklist

- Carriers `15000` / `16500` Hz, symbol time `20 ms` (the validated
  configuration), or run channel calibration first.
- Speaker volume high enough to be picked up, microphone
  unobstructed, room reasonably quiet.
- Press **START LISTENING** before transmitting.
- A successful run ends with the decoded text matching the input and
  the CRC badge reading `CRC OK`.

## Reference result

The repository ships a still capture of a real run:

```
docs/screenshots/06-physical-validation.png
```

Message `Hello from Auralynk.` · F0 15,000 Hz · F1 16,500 Hz ·
20 ms symbols · 48,000 Hz microphone · CRC OK — verified 2026-10-07
(machine report: `docs/testing/physical-loopback-2026-10-07.json`).
