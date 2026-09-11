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

## Continuous calibration

The latency constant is re-measured **every beat**, for the whole session.

This is not a refinement. Measured on the real device, the round trip was 353 ms during
one take and 394 ms ninety seconds later in the same session, each rock-steady within
itself. A single calibration at start-up would have been 41 ms wrong by the end of a
short practice — the entire width of the "perfect" window. She would be told she was on
time at the start of an exercise and late at the end of it, purely from drift.

**What adapts continuously, and what must never:**

| Adapts | From what | Why it's safe |
| --- | --- | --- |
| Detection threshold | Per-band noise floor | Only affects *whether* a hit is seen, not *when* |
| Latency constant K | The metronome click heard back through the mic | The app generated the click; it knows nothing about her playing |
| Double-hit rejection | The note spacing the exercise asks for | Fixed by the music, not by her |

The one thing that must **never** feed back is her own playing. Adapting K from her hits
would centre her errors on zero by construction: a child who consistently rushes would
be told she is perfect, and the app would have erased the very thing it exists to show
her. There is deliberately no API for a hit to reach `TimingModel`, and a test asserts
it stays that way.

Discriminating the click from a drum hit is easy because they are opposites — the click
is sustained narrowband energy with nothing up high, a stick is a broadband impulse.
Against the real recordings this gives sub-millisecond agreement with an independent
matched-filter analysis, and **zero** phantom clicks from fifteen seconds of drumming.

If the number stops holding still, the app stops scoring and says so, rather than
reporting timing it cannot stand behind. Refusal keys on instability, not size.

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

## It tunes itself

There is no setup step. The app works out, on its own, which frequencies separate her
drum from the metronome bleeding out of *this* speaker in *this* room — the thing that
originally took an offline recording session.

It can do that because it already has everything the recording provided:

| What it needs | Where it gets it, for free |
| --- | --- |
| Round-trip latency | Its own click, heard back, every beat |
| The metronome's spectrum | The same click — sampled across the filterbank on arrival |
| The room's own noise | The gaps between count-in clicks |
| Her drum's spectrum | Every hit carries its per-band levels |
| Which bands to trust | The margin between those |

The four-beat count-in is the key: the metronome is playing and she is meant not to be,
at the start of every single exercise, forever. Samples spoiled by her playing anyway
are simply discarded — telling an eight-year-old to hold still mostly would not work.

Two guardrails. Bleed is measured at a high percentile and hits at a low one, so the
margin is the pessimistic case rather than the flattering average. And the level gate
can never rise above her softest hits: going quietly deaf would look exactly like the
app ignoring her, which is worse than the occasional false trigger.

Verified in `test/autotune.test.mjs` by handing the learner a candidate list that
deliberately *includes* the bands the click lives in, and replaying real audio: it drops
them unaided and reaches zero false triggers from the metronome.

### Difficulty looks after itself too

Timing windows sit on an **Auto** setting by default. After each attempt the app looks at
the median of her recent steadiness and moves the level when she has clearly outgrown it,
with hysteresis so it cannot flap and so one lucky attempt cannot promote her. Levelling
up is a celebration; easing back happens silently, because telling a child the app thinks
she got worse is the opposite of the point. Any of the three levels can still be pinned
by hand.

## Checking it isn't lying — `?selftest`

Open **`/?selftest`** on the device she practises on, press Play, then Run.

It plays sixteen fake hits through the speaker, each exactly 50 ms after the beat, and
asserts the app reports +50 ms back. That exercises the entire chain on real hardware —
speaker, room, microphone, continuous latency calibration, detection, scoring — with no
human involved.

The arithmetic is exact, which is what makes it a fair test. A real stick struck at time
T is heard at T + inputLatency, and the app subtracts K = outputLatency + inputLatency,
reporting T − noteTime − outputLatency: her error as she perceives it, since she hears
the click late by the output latency too. A synthetic hit scheduled at graph time S
emerges at S + outputLatency and is heard at S + outputLatency + inputLatency, so after
the same K the app reports exactly S − noteTime.

**Run this first on any new device, and first if the feedback ever looks wrong.** A
failure means the numbers she is being shown are wrong. It refuses to certify a pass it
cannot evidence: if it can't hear the test hits, it says so rather than reporting success.

## Re-measuring by hand (optional)

Not needed in normal use — the app tunes itself. Reach for this only to investigate a
device where detection misbehaves, or to regenerate the test fixtures.

1. Open `/tools/record.html` on the device in question.
2. Do the five short takes it walks you through, about three minutes.
3. Move the downloaded files into `tools/recordings/`.
4. `npm run analyse` for the spectra, `node tools/tune.mjs --sweep` for detector settings.

`node tools/make-fake-recordings.mjs` writes synthetic takes so the tools can be
exercised without a drum pad. With real recordings present, `npm test` additionally
replays them and asserts the calibration and the band learner still behave.

### What the first measurement found (2026-09-10, Android Chrome)

Three things guesswork would have got wrong:

- **One biquad per band is not enough.** A single 2nd-order bandpass rolls off at only
  6 dB/octave, leaving the 900 Hz metronome click barely 13 dB down inside the 2.5 kHz
  band — so it triggered the detector as readily as a real drum hit. An FFT view of the
  same bands looks perfectly clean and hides this completely. Cascading three biquads
  took false triggers from the metronome from 6 to **0**.
- **Round-trip latency is 353 ms** — and drifted to 394 ms ninety seconds later in the
  same session, each rock-steady within itself. That is why calibration is continuous.
- **The accelerometer is a confirmation sensor, not a timing source.** It feels hits
  clearly (21 dB spike-to-rest at 60 Hz) but its timestamps scatter ~38 ms against the
  microphone, because `DeviceMotionEvent` delivery waits on the main thread.

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

## Score, and watching it move

Each attempt ends with one number rather than four statistics, because four is more than
an eight-year-old should have to synthesise. It weighs, in order:

- **steadiness**, the thing she is actually training and the only part that does not
  depend on the latency calibration being right;
- **coverage**, squared, or the winning strategy would be to play three notes beautifully
  and ignore the rest;
- **best streak**, because it is the part she cares about;
- **difficulty**, as a multiplier on notes per minute, so climbing the exercise ladder
  pays and the high score does not live forever on quarter notes at 60 BPM.

It is deliberately independent of the fussiness level: that setting changes how
encouraging the words are, not how well she played.

Scores are kept on the device (`localStorage`) so she can see "better than last time",
"best today", and "best ever" — with a personal best getting its own moment. A worse
attempt shows a shorter bar, never a red number, and the running best stays in view so
one bad go never erases a good one.

## Privacy

Audio is analysed in the page and discarded. Nothing is recorded or uploaded, and there
are no network calls at runtime. Scores, the chosen level, and the last measured latency
are stored locally on the device and never leave it.

## Not affiliated with anything

The look and the jug band are an affectionate nod to a certain 1977 Christmas special
about some otters. Made for one kid, shared in case it's useful.
