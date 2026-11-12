/**
 * BudouX reads UTF-16 units and can name a boundary between the two halves of a
 * surrogate pair; breaking there would leave half a character in a run. A
 * phrase ending on a high surrogate is joined to the one that follows.
 */
export function withoutPairCuts(phrases: readonly string[]): readonly string[] {
  const joined: string[] = []
  let carried = ''
  for (const phrase of phrases) {
    const whole = carried + phrase
    const last = whole.charCodeAt(whole.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) carried = whole
    else {
      joined.push(whole)
      carried = ''
    }
  }
  if (carried !== '') joined.push(carried)
  return joined
}
