// What each function in a file scores for cognitive complexity, and how that
// moved across a diff. Pure: `complexity-of.mjs` runs biome and reads git; the
// tests feed this the JSON biome actually emits.
//
// Why a measurement needs its own tool: biome REPORTS a function only when it
// is over `maxAllowedComplexity`, and `biome.json` switches the rule off for
// every file on its exemption list — so neither `pnpm lint` nor the config can
// say what a function scores, which is the number a review of "did this diff
// make it harder to follow?" needs.

/** `--base <ref>`, `--changed`, and the files named — every other argument. */
export function argsFrom(argv) {
  const baseAt = argv.indexOf('--base')
  const base = baseAt === -1 ? null : argv[baseAt + 1]
  const files = argv.filter((a, i) => !a.startsWith('--') && (baseAt === -1 || i !== baseAt + 1))
  return { base, changed: argv.includes('--changed'), files }
}

/** The threshold `biome.json` enforces, read from the config rather than restated. */
export function thresholdFrom(biomeJson) {
  const match = /"maxAllowedComplexity"\s*:\s*(\d+)/.exec(biomeJson)
  if (match === null) throw new Error('biome.json names no maxAllowedComplexity')
  return Number(match[1])
}

/**
 * `{ file, name, line, score }` per function, from biome's `--reporter=json`
 * output and the sources it read. The diagnostic's span IS the function's
 * name, so the name is cut from the source rather than guessed by a regex.
 *
 * @param report parsed biome JSON
 * @param sourceOf (path) => file contents, for the path as biome reported it
 * @param displayPath (path) => the path to print, since the base side is read
 *   from a temp copy
 */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

export function scoresFrom(report, sourceOf, displayPath = (path) => path) {
  const rows = []
  for (const d of report.diagnostics ?? []) {
    if (d.category !== 'lint/complexity/noExcessiveCognitiveComplexity') continue
    const score = /complexity of (\d+)/.exec(d.message)
    if (score === null) continue
    const { path, start, end } = d.location
    const lines = sourceOf(path).split('\n')
    const text = lines[start.line - 1] ?? ''
    const span = start.line === end.line ? text.slice(start.column - 1, end.column - 1) : ''
    // An arrow or a callback has no name, and its span is `=>` or a keyword:
    // printed as anonymous, and never joined to the base by that non-name.
    const name = IDENTIFIER.test(span) ? span : '(anonymous)'
    rows.push({ file: displayPath(path), name, line: start.line, score: Number(score[1]) })
  }
  return rows
}

/**
 * Head rows joined to base rows by (file, name), with the delta. A function
 * only in head is new (`base: null`); one only in base is reported as gone so
 * a split reads as what it is rather than as a function that vanished.
 */
export function compare(baseRows, headRows) {
  // An anonymous function has nothing stable to join on — its line moves with
  // every edit above it — so it is keyed by line and reads as new or gone.
  const key = (r) => (IDENTIFIER.test(r.name) ? `${r.file}\0${r.name}` : `${r.file}\0@${r.line}`)
  const base = new Map(baseRows.map((r) => [key(r), r]))
  const seen = new Set()
  const out = headRows.map((h) => {
    const b = base.get(key(h))
    seen.add(key(h))
    return { ...h, base: b ? b.score : null, delta: b ? h.score - b.score : null }
  })
  const gone = baseRows.filter((b) => !seen.has(key(b)))
  // A function that left one file for another — a module extraction — is
  // joined across files by name, but only when the name is unique on both
  // sides: two `helper`s are not guessed between.
  const onlyOne = (rows, name) => rows.filter((r) => r.name === name).length === 1
  const arrived = out.filter((h) => h.base === null && IDENTIFIER.test(h.name))
  const moved = new Set()
  for (const h of arrived) {
    const b = gone.find((g) => g.name === h.name)
    if (b === undefined || !onlyOne(gone, h.name) || !onlyOne(arrived, h.name)) continue
    Object.assign(h, { base: b.score, delta: h.score - b.score, from: b.file })
    moved.add(b)
  }
  for (const b of gone) {
    if (!moved.has(b)) out.push({ ...b, score: null, base: b.score, delta: null })
  }
  return out
}

/**
 * The table. Shows what a reader has to act on: anything over the threshold,
 * anything within `near` of it, anything whose score moved — and, against a
 * base, every function that is NEW, GONE or MOVED whatever it scores. Those two are
 * how complexity MOVES: a function that dropped from 25 to 4 says nothing
 * until the 21 that left can be seen arriving somewhere, which is the
 * difference between removing branches and relocating them.
 */
export function formatTable(rows, threshold, near = 3) {
  const floor = threshold - near
  const isNewOrGone = (r) => 'base' in r && (r.base === null || r.score === null || r.from !== undefined)
  const worth = rows.filter(
    (r) =>
      (r.score ?? 0) >= floor || (r.base ?? 0) >= floor || (r.delta ?? 0) !== 0 || isNewOrGone(r),
  )
  worth.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.file.localeCompare(b.file))
  const hasBase = rows.some((r) => 'base' in r)
  const lines = [
    hasBase ? 'score  base  delta  function' : 'score  function',
  ]
  for (const r of worth) {
    const flag = (r.score ?? 0) > threshold ? '!' : (r.score ?? 0) >= threshold - near ? '~' : ' '
    const score = r.score === null ? '   -' : String(r.score).padStart(4)
    const where = `${r.file}:${r.line}  ${r.name}${r.from ? `  (from ${r.from})` : ''}`
    if (!hasBase) {
      lines.push(`${flag}${score}  ${where}`)
      continue
    }
    const base = r.base === null ? '   new' : String(r.base).padStart(6)
    const delta =
      r.delta === null ? (r.score === null ? '  gone' : '      ') : `${r.delta > 0 ? '+' : ''}${r.delta}`.padStart(6)
    lines.push(`${flag}${score}${base} ${delta}  ${where}`)
  }
  lines.push('', `! over the ${threshold} threshold   ~ within ${near} of it`)
  return lines.join('\n')
}
