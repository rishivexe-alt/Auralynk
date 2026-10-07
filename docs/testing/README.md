# Verification Evidence

Everything in this folder is captured output from real runs on the
project — no hand-written results.

## What is stored here

| File | What it is |
| --- | --- |
| `dsp-test-output.txt` | Full stdout of `npm test` — the deterministic DSP suite (`scripts/verify-dsp.mjs`). |
| `browser-e2e-output.txt` | Headless-Chrome load of the production build (`npm run build` → `npm run preview`): DOM assertions, resource failures, console errors. |
| `physical-loopback-2026-10-07.json` | Machine-generated report from a real speaker → air → microphone transmission performed during repository packaging. |

## The three levels of evidence

These are different *kinds* of proof. One never substitutes for another.

### Level 1 — deterministic DSP tests (`npm test`)

- Runs in Node.js. No browser, no microphone, no speakers.
- Loads the real TypeScript sources through Vite's SSR loader, so the
  code under test is exactly the code that ships.
- Covers CRC-16 known answers, packet build/parse round trips,
  corruption and truncation handling, modulate → demodulate end-to-end
  across sample rates, chunk sizes and symbol phases, AWGN channels at
  20 dB and 12 dB, and transmitter clock drift of ±0.1 % and ±0.3 %.
- **Result: 60 / 60 checks passing.**
- Answers: *is the DSP correct and robust?*

### Level 2 — browser end-to-end (`npm run build` + `npm run preview`)

- Serves the production bundle and loads it in Chrome.
- Asserts the page title, Auralynk branding, favicon resolution, that
  the application mounts, that all six page sections and both canvases
  render, and that there are **zero console errors and zero failed
  network requests**.
- Answers: *does the built application actually run in a browser?*

### Level 3 — physical acoustic validation

- Real speaker, real air path, real microphone, real room. No signal
  injection, no fake audio device.
- Configuration used: F0 15,000 Hz · F1 16,500 Hz · 20 ms symbols ·
  48,000 Hz microphone · message `Hello from Auralynk.` (20 bytes →
  224 symbols → 4480 ms).
- Result: the receiver reported the expected message with **CRC OK**.
  The captured report for the 2026-10-07 run is stored in
  `physical-loopback-2026-10-07.json`; the corresponding UI capture is
  `../screenshots/06-physical-validation.png`.
- Answers: *does the system survive a real acoustic channel?*

Note on the counters visible during a physical run: `BITS` counts every
symbol the demodulator decided (including symbols from parallel phase
hypotheses that never form a frame), and `CRC FAILS` counts candidate
frames rejected during acquisition. Neither is a count of "corrupted
user messages".

## Reproducing

```bash
npm install
npm run check     # Level 1 (tests) + typecheck + production build
npm run dev       # open http://localhost:5173 for manual / physical runs
```

For a Level 3 run: open two tabs (or one tab and repeat), set the
carriers to `15000` / `16500`, keep symbol time at `20 ms`, press
**START LISTENING**, then **TRANSMIT MESSAGE** with the speakers
audible and the microphone unobstructed.
