/**
 * One definition of "is this a Mac-family platform", for chrome that names
 * the command modifier. Two components had already grown their own copy of
 * this regex before it moved here (the StateDot lesson: private copies of
 * the same literal drift).
 *
 * `navigator.platform` is deprecated-but-stable and remains the practical
 * signal for keyboard-modifier display; `userAgentData.platform` is not on
 * Firefox/Safari. Read at call time so a test can stub the navigator.
 */
export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
}
