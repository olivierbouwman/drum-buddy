# Drum Buddy

A drum timing trainer for a young beginner with a rubber practice pad, two sticks, and
a lesson once a week.

It plays a beat out loud, listens, and shows how her hits sit against it — as a rabbit
(a bit quick), a turtle (a bit slow), or a star (right on it). A jug band wakes up one
member at a time as her streak grows, so the reward for playing steadily is more music.

**Play it:** https://olivierbouwman.github.io/drum-buddy/

## The one rule

The app must never tell an on-time child that she is late.

Speaker output plus microphone input adds 30–150 ms of delay that is mathematically
indistinguishable from playing late. Left uncorrected, this app would tell a perfectly
on-time eight-year-old she is always behind, and she would spend weeks trying to fix a
bug. Three things exist purely to prevent that, and nothing else in the codebase is
allowed to be more complicated than it needs to be:

1. **Latency calibration** — measures the real round trip and subtracts it.
2. **Order-preserving beat matching with a displacement guard** — stops a child who is
   a whole beat behind from being scored as perfect. See `src/scoring.js`.
3. **Steadiness as the headline metric** — spread doesn't depend on the calibration at
   all, so it stays honest even when calibration fails. It also avoids branding a child
   a "rusher" for anticipating the beat, which is normal and expected at this age.

`npm test` covers all of this, including the sign convention, and gates deployment.

## Running it

```sh
npm install
npm run dev          # http://localhost:5174
npm test             # timing and scoring tests
npm run build
```

`?debug` adds a parent/teacher panel with the raw numbers (milliseconds, drift,
extra hits). Those never appear on the child's screen.

For an iPad you need HTTPS — both `getUserMedia` and `DeviceMotionEvent` require a
secure context, and `localhost` doesn't apply. Either open the deployed URL above, or
run `npm run dev:lan` and accept the self-signed certificate once.

## Measuring the real pad (Phase 0)

Detection thresholds should come from the actual pad, sticks, speakers and room rather
than from guesses — in particular whether her stick attack is audible in a frequency
band the metronome click isn't, and whether the accelerometer feels hits through the
rubber at all.

1. Open `/tools/record.html` (on the device you'll practise on).
2. Do the five short takes it walks you through — about three minutes.
3. Move the downloaded files into `tools/recordings/`.
4. `npm run analyse`

It prints an energy-per-band table, recommends a detection band, and says plainly
whether the microphone route, the accelerometer route, or both are viable.

`node tools/make-fake-recordings.mjs` writes synthetic takes so the analyser can be
exercised without a drum pad.

## How it's put together

| File | What it does |
| --- | --- |
| `src/config.js` | Every tunable number, in one place |
| `src/scoring.js` | Beat matching and statistics — the correctness heart |
| `src/scheduler.js` | Lookahead metronome scheduling |
| `src/audio-engine.js` | AudioContext lifecycle and the audio↔animation clock mapping |
| `src/input-sources.js` | Taps now; microphone and accelerometer behind the same interface |
| `src/exercises.js` | The beginner ladder, as plain data |
| `src/visuals.js` | Bouncing ball and per-hit feedback |

**Invariant:** everything measured lives in `AudioContext` time. `performance.now()` is
used only for animation. Mixing the two is how timing bugs get in.

## Accessibility

No verdict is ever carried by colour alone — each is an animal, a word, and a position
on the lane. `prefers-reduced-motion` calms the animation rather than removing the beat
cue. Fully keyboard operable. All colours were contrast-checked against both background
tones and pass WCAG AA, most AAA.

## Privacy

Audio is analysed in the page and discarded. Nothing is recorded, stored, or uploaded,
and there are no network calls at runtime.

## Not affiliated with anything

The look and the jug band are an affectionate nod to a certain 1977 Christmas special
about some otters. Made for one kid, shared in case it's useful.
