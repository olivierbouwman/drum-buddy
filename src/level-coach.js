/**
 * Decides when to make the app fussier, or kinder, about her timing.
 *
 * A fixed window cannot serve a complete beginner and the same child six months later.
 * Rather than making a parent notice and intervene, the app watches her steadiness and
 * moves the level itself.
 *
 * Three things keep it from being annoying:
 *
 *   - HYSTERESIS. It won't move again until she has played several attempts at the
 *     current level, so it can't oscillate on one good or one bad go.
 *   - MEDIAN, not last. One brilliant attempt shouldn't promote her into a level she
 *     will then fail at, and one distracted attempt shouldn't demote her.
 *   - ASYMMETRY. Promotion is a celebration; easing back is silent. A child being told
 *     the app has decided she got worse is the opposite of the point.
 *
 * It judges on SPREAD rather than on score, because the score also moves with tempo and
 * which exercise she picked, and neither of those says anything about her ability.
 */

const MIN_ATTEMPTS = 4
const WINDOW = 5

const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * @param {number[]} spreads recent steadiness readings, newest last
 * @param {number} currentIndex index into levels
 * @param {number} attemptsHere attempts since the level last changed
 * @param {Array} levels the LEVELS table
 * @returns {{index:number, direction:'up'|'down'|'stay', reason:string}}
 */
export function assess (spreads, currentIndex, attemptsHere, levels) {
  const stay = { index: currentIndex, direction: 'stay', reason: 'holding' }
  if (spreads.length < 3) return { ...stay, reason: 'not enough attempts yet' }
  if (attemptsHere < MIN_ATTEMPTS) return { ...stay, reason: 'settling in' }

  const typical = median(spreads.slice(-WINDOW))
  const here = levels[currentIndex]

  // Comfortably earning the top badge at the next level up? Then she has outgrown this one.
  const next = levels[currentIndex + 1]
  if (next && typical < next.steady[0]) {
    return { index: currentIndex + 1, direction: 'up', reason: `steady at ${Math.round(typical)} ms` }
  }

  // Consistently in the bottom band here? Make it kinder so she can see progress again.
  const prev = levels[currentIndex - 1]
  if (prev && typical > here.steady[2]) {
    return { index: currentIndex - 1, direction: 'down', reason: `struggling at ${Math.round(typical)} ms` }
  }

  return { ...stay, reason: `typical spread ${Math.round(typical)} ms` }
}
