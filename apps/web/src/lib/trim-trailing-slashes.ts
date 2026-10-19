/**
 * `s` without its trailing run of `/`. Equivalent to `s.replace(/\/+$/, '')`,
 * which a regex engine retries from every slash of a run that does not end
 * the string — quadratic in that run. One backward walk is linear.
 */
export function trimTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 0x2f) end--
  return end === s.length ? s : s.slice(0, end)
}
