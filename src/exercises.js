/**
 * The beginner ladder — one practice pad, two sticks, nothing else.
 *
 * This follows the order a drum teacher actually uses for a complete beginner. The
 * first three rudiments in the standard list (single stroke roll, double stroke roll,
 * single paradiddle) are all playable on a bare pad and are what a first year is
 * mostly made of — the classic pad book, Stone's "Stick Control", is essentially
 * hundreds of variations on those.
 *
 * Two things beginners are taught that this app can reinforce:
 *   - COUNT OUT LOUD. Saying "1 and 2 and" is how the subdivision gets internalised.
 *     Each exercise carries the words to say.
 *   - EVEN HANDS. The weak hand lags and hits quieter; the whole point of alternating
 *     and double-stroke work is to even them out.
 *
 * What this app deliberately does NOT try to teach: grip, stick height, posture, and
 * rebound. Those need a human watching her hands — that's what the weekly lesson is
 * for. The tips below only nudge; they don't pretend to replace a teacher.
 *
 * `at` is in beats from the start of the bar, so 0.5 is an off-beat eighth.
 */

const quarters = (hand) => [0, 1, 2, 3].map((at) => ({ at, hand }))

/** R L R L across the bar. */
const singles = [0, 1, 2, 3].map((at, i) => ({ at, hand: i % 2 ? 'L' : 'R' }))

/** Eighth notes, alternating: R L R L R L R L. */
const eighthSingles = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]
  .map((at, i) => ({ at, hand: i % 2 ? 'L' : 'R' }))

/** Slow doubles: R R L L, one per beat. */
const doubles = [
  { at: 0, hand: 'R' }, { at: 1, hand: 'R' },
  { at: 2, hand: 'L' }, { at: 3, hand: 'L' },
]

/** Single paradiddle: R L R R / L R L L as eighth notes. */
const paradiddle = [
  { at: 0, hand: 'R' }, { at: 0.5, hand: 'L' }, { at: 1, hand: 'R' }, { at: 1.5, hand: 'R' },
  { at: 2, hand: 'L' }, { at: 2.5, hand: 'R' }, { at: 3, hand: 'L' }, { at: 3.5, hand: 'L' },
]

export const EXERCISES = [
  {
    id: 'quarters-right',
    name: 'Right hand',
    blurb: 'One hit on every beep, right hand only.',
    tip: 'Hold the stick like you are shaking hands with it — not too tight!',
    count: '1  2  3  4',
    emoji: '🥁',
    bars: 8,
    beatsPerBar: 4,
    notes: quarters('R'),
  },
  {
    id: 'quarters-left',
    name: 'Left hand',
    blurb: 'Same again, with your left hand.',
    tip: 'This hand gets less practice, so it feels funny. That is normal!',
    count: '1  2  3  4',
    emoji: '🥁',
    bars: 8,
    beatsPerBar: 4,
    notes: quarters('L'),
  },
  {
    id: 'singles',
    name: 'Right, left, right, left',
    blurb: 'Swap hands every single hit.',
    tip: 'Try to make both hands sound exactly the same. Lift both sticks the same height.',
    count: 'R  L  R  L',
    emoji: '🙌',
    bars: 8,
    beatsPerBar: 4,
    notes: singles,
  },
  {
    id: 'slow-notes',
    name: 'Waiting game',
    blurb: 'Only hit on beats 1 and 3. Wait for it!',
    tip: 'Keep counting in your head through the gaps — that is the whole trick.',
    count: '1  (2)  3  (4)',
    emoji: '🐢',
    bars: 8,
    beatsPerBar: 4,
    notes: [{ at: 0, hand: 'R' }, { at: 2, hand: 'L' }],
  },
  {
    id: 'eighths',
    name: 'Double speed',
    blurb: 'Two hits for every beep, swapping hands.',
    tip: 'Say it out loud: "1 and 2 and 3 and 4 and". Out loud really does help!',
    count: '1 & 2 & 3 & 4 &',
    emoji: '⚡',
    bars: 8,
    beatsPerBar: 4,
    notes: eighthSingles,
  },
  {
    id: 'doubles',
    name: 'Two in a row',
    blurb: 'Two hits with the same hand, then swap.',
    tip: 'Right, right, left, left. Make the second hit as loud as the first.',
    count: 'R  R  L  L',
    emoji: '✌️',
    bars: 8,
    beatsPerBar: 4,
    notes: doubles,
  },
  {
    id: 'paradiddle',
    name: 'Paradiddle',
    blurb: 'Right left right right, left right left left.',
    tip: 'Say the name while you play it: "pa-ra-did-dle". It fits perfectly!',
    count: 'pa ra did dle pa ra did dle',
    emoji: '🌀',
    bars: 8,
    beatsPerBar: 4,
    notes: paradiddle,
  },
]

export const byId = (id) => EXERCISES.find((e) => e.id === id) || EXERCISES[0]
