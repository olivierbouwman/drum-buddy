# Drum Buddy

A drum timing trainer for a young beginner with a rubber practice pad, two sticks, and a
lesson once a week.

It plays a beat out loud, feels her hits through the tablet resting on the pad, and shows
how they sit against the beat — a rabbit for a bit quick, a turtle for a bit slow, a star
for right on it. Five minutes of actual drumming a day, and it decides what to practise.

**Play it:** https://olivierbouwman.github.io/drum-buddy/

## The one rule

**The app must never tell an on-time child that she is late.**

Speaker output plus sensor input adds delay that is mathematically indistinguishable from
playing late. Uncorrected, this app would tell a perfectly on-time eight-year-old she is
always behind, and she would spend weeks trying to fix a bug. Three things exist purely to
prevent that:

1. **Latency correction** — what the browser reports, plus the sensor's own delay, plus a
   head start on the click so the sound lands when the app says it will.
2. **Order-preserving beat matching with a displacement guard** — stops a child who is a
   whole beat behind from being scored as perfect (`src/scoring.js`).
3. **Steadiness as the headline** — spread barely depends on the latency constants, so it
   stays honest even when they are off. It also avoids branding a child a rusher for
   anticipating the beat, which is normal at this age.

The other half of that rule: **her own playing must never feed back into the timing
constants.** Doing so would centre her errors on zero by construction — a child who rushes
would be told she is perfect, and the app would have erased the thing it exists to show
her. The `?tune` screen deliberately *displays* her measured offset rather than zeroing it.

`npm test` covers this, including the sign convention, and gates deployment.

## How it senses her

**The accelerometer decides when she hit.** The tablet rests on the practice pad and feels
the strike. It is physically immune to the two hardest problems here — the metronome
bleeding out of the speaker, and a noisy room — and needs no per-room tuning.

**The microphone scores nothing and times nothing.** It is a fallback for a device that
cannot feel the pad, such as a laptop. It used to measure latency and check the volume;
neither survived contact with the tablet, and a dead microphone now costs nothing.

## Timing, and the four bugs that hid in it

Every number below was measured on the actual device. Each of these was invisible from the
outside and produced the same symptom — "the sound feels late" — from a different cause.

**`ctx.currentTime` is not a clock.** On this tablet it advances in 85 ms steps — one
4096-frame output buffer — and stands perfectly still in between. Every hit stamped with it
was snapped to that grid before anything else happened. A uniform error that wide has a
p90−p10 of 68 ms, and the app had been reporting a "spread" of about 70 ms: it was
measuring its own clock. `engine.nowFine` recovers real time by tracking the *minimum* of
`performance.now() − currentTime` across many samples — the sample taken just after a tick,
where the staircase error is nearly zero. Averaging would bake in half a step.

**Web Audio has two latencies in series.** `baseLatency` (graph → audio subsystem) and
`outputLatency` (subsystem → speaker) are additive per the spec, and the app counted only
the second. The click therefore came out a whole `baseLatency` late, every beat.

**`outputLatency` is not a constant.** It was read once at startup. Android changes it
mid-session — a real run recorded it moving 169 ms → 86 ms as the audio path reconfigured.
Everything downstream is a function of it, so the app went 83 ms wrong partway through a
practice and stayed wrong. It is now re-read every 250 ms, and both the pad correction and
the click's head start recompute when it moves.

**A calibration reference had the output latency folded into it.** Screen-tap calibration
was stamped through the animation clock, which carries output latency by design — so the
measured "pad delay" was really *sensor delay + output latency*, and it was then added a
second time. 356 ms was being subtracted where 185 ms was right.

### Where the numbers come from now

| Term | Source |
| --- | --- |
| Output latency | `ctx.outputLatency`, re-read continuously |
| Pad sensor delay | ~15 ms constant; measurable with `?calibrate`, hand-settable in `?tune` |
| Click head start | `?tune` if set, else `baseLatency`, else half the mic round trip |

A hand-set value outranks every derivation, and **pins** the pad delay so no live
cross-calibration can silently replace it mid-session.

### What was tried and did not work

Kept because the negative results are load-bearing.

- **Deriving the head start.** `baseLatency` said 85 ms; half the measured 496 ms round trip
  said 77 ms. Tuned by ear: **125 ms**. Two independent estimates agreeing was not evidence
  they were right — they shared the assumption that the reported figures describe the whole
  path, and that is what failed.
- **Hearing the speaker with the accelerometer.** Would have measured output latency with no
  microphone and no human. This tablet's accelerometer *latches* when still: 3177 samples
  across 48 seconds, one value, both channels. No dither, so no amount of averaging recovers
  anything. `tools/speaker-latency.mjs` performs the test and reports it honestly.
- **Blaming the clocks for drift.** Measured at **6 ppm** — 2 ms across a session.
  `tools/clock-drift.mjs` fits the slope; the answer was the stale `outputLatency` above.

## `?tune` — setting it by ear

Long-press the title on the start screen (or tap it five times, or use `?tune`). Two steps:

1. **Line the beep up with the flash.** An endless beat and a circle that flashes on the beat
   grid. The onset is instantaneous and lasts three frames, and it lands on a real animation
   frame rather than a `setTimeout` — a tuner whose own light jitters by 15 ms cannot resolve
   anything finer.
2. **Drum along and read the number.** Deliberately a readout, not a "tap and I'll work it
   out". Taking the median of someone's playing and calling it zero would define on-time as
   wherever that person plays, and the child would inherit an adult's lean. The number
   separates what feel cannot: whether the app is wrong, or whether you are simply early.

Stored per device, shared by every player — it describes the tablet, not the person.

## The daily five minutes

Bars are derived from a **time target**, not fixed, so the session stays five minutes as she
gets faster. Fixed bar counts made it quietly shorter — and a bar-*count* ceiling did the
same thing again at the top of the tempo range, since a bar at 120 BPM is a third of a bar
at 40. The cap is a duration now, and every tempo from 40 to 120 gets its five minutes.

A session is: a warm-up, today's focus, **the other hand** where the exercise is
hand-specific, and a favourite to finish. Practising the right hand twice and the left not
at all is how a weak hand stays weak.

Seven exercises, as plain data in `src/exercises.js`. Tempo rises when she is steady at the
current one and eases back if she is struggling — silently, because telling a child the app
thinks she got worse is the opposite of the point. The weekly goal is four days, not seven:
she has a lesson day and will miss days.

## Running it

```sh
npm install
npm run dev          # http://localhost:5174
npm run dev:lan      # HTTPS on the LAN, for testing on the tablet
npm test             # 219 assertions across 8 files; gates deployment
npm run build
```

| URL | What it does |
| --- | --- |
| `?debug` | Parent panel: raw milliseconds, drift, extra hits. Never on her screen. |
| `?tune` | Set the sound/picture offset by ear. Also via long-press on the title. |
| `?selftest` | End-to-end honesty check — see below. |
| `?calibrate` | Re-measure the pad sensor delay by tapping the screen. |
| `?speakertest` | Can the accelerometer feel the speaker? (On this tablet: no.) |

`dev:lan` also enables diagnostics — the tablet uploads snapshots, full session traces and
clock traces to the dev server, which is how most of the bugs above were found. Local
network only, measurements only, and off entirely in the deployed build.

### `?selftest`

Plays sixteen fake hits through the speaker, each exactly 50 ms after the beat, and asserts
the app reports +50 ms. That exercises the whole chain on real hardware with no human
involved. **Run it first on any new device, and first if the feedback ever looks wrong.** It
refuses to certify a pass it cannot evidence.

## Installing on the tablet

"Add to Home screen" in Chrome gives a genuine fullscreen window — the Fullscreen API is
granted and then silently ignored on this device, leaving 168 px of browser chrome. Install
from the deployed URL, not the LAN address: Android builds the app package on Google's
servers, which cannot reach a private IP, so it reports "Installing…" and then nothing.

The installed app **updates itself**. There is no address bar to reload from, so it checks
on launch and on returning to the foreground, and applies a waiting build only when no
exercise is running — a reload mid-take would drop the run.

## How it's put together

| File | What it does |
| --- | --- |
| `src/config.js` | Every tunable number, in one place, with the reasoning |
| `src/timing-model.js` | Owns the latency constants — the correctness heart |
| `src/scoring.js` | Beat matching, steadiness, drift, streaks |
| `src/practice-plan.js` | Builds the daily five minutes |
| `src/audio-engine.js` | AudioContext lifecycle, and the clock mapping everything depends on |
| `src/scheduler.js` | Lookahead metronome scheduling |
| `src/motion-detector.js` | Pad sensor: threshold, peak picking, rebound rejection |
| `src/onset-detector.js` | Microphone fallback: filterbank onset detection |
| `src/dsp-core.js` | Pure DSP shared by the worklet, the tests and the offline tools |
| `src/visuals.js` | Falling notes in two lanes, strike lines, per-hit feedback |
| `src/level-coach.js` | Moves the difficulty as she improves |
| `src/diagnostics.js` | Dev-server-only telemetry |

**Invariant:** everything measured lives in `AudioContext` time; `performance.now()` is for
animation and for UI gestures only. Mixing the two is how timing bugs get in — and reaching
for the measurement clock to time a *gesture* is how "hit the pad three times" broke.

## Accessibility

No verdict is carried by colour alone — each is an animal, a word, and a position on the
lane. `prefers-reduced-motion` calms the animation rather than removing the beat cue, and
nothing flashes above 3 Hz at any tempo. Fully keyboard operable. Colours contrast-checked
against both background tones: WCAG AA throughout, mostly AAA.

## Privacy

Audio is analysed in the page and discarded. Nothing is recorded or uploaded, and there are
no network calls in the deployed build. Scores, level, players and the timing constants live
in `localStorage` and never leave the device. Diagnostics exist only on the dev server, stay
on the local network, and carry measurements rather than audio.

## To do

- **Badges and rewards.** Asked for, never built. Roughly ten milestones, a collection screen
  with silhouettes for unearned ones, CSS-only animation.
- **Re-check the tuned offset.** The installed app carries 125 ms, set while the device
  reported 169 ms output latency. The best-measured run derived 43 ms at the current 86 ms.
  If the sound feels early, `?tune` → **Start over** clears it and lets it derive.
- **Decide what a changing `outputLatency` means for a tuned offset.** The app assumes the
  reported figure is honest and keeps the tuned head start fixed. If instead only the
  *report* moves, the head start should move the opposite way. Needs one run in each audio
  configuration to settle.
- **Real-audio tests skip in CI** — the recordings are gitignored. A trimmed fixture would
  let the detector tests run on every push.
- **The microphone still never corroborates a hit** on this tablet. Not a problem while the
  pad sensor works, but it means the exact cross-calibrated correction is never available.

## Not affiliated with anything

The look is an affectionate nod to a certain 1977 Christmas special about some otters. Made
for one kid, shared in case it's useful.
