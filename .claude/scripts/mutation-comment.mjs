#!/usr/bin/env node
// Renders a Stryker JSON report as the sticky PR comment body.
//
// The lane this serves is REPORT-ONLY, which makes visibility its whole
// problem: a weekly HTML artifact is a number nobody opens, and a survivor
// nobody reads is the same as no lane at all. So the numbers go where the
// author already is.
//
//   node .claude/scripts/mutation-comment.mjs <report.json> [--marker <html-comment>] \
//     [--equivalents <stryker-targets.mjs>]
//
// Prints markdown to stdout, or NOTHING when the report holds no mutants —
// the common case, since most diffs touch none of the mutated modules, and a
// comment saying "nothing to say" is the noise that gets bots muted.

import { readFileSync } from 'node:fs'

/**
 * The exact source a mutant replaced, so a survivor can be recognised by WHAT
 * it changed rather than by where. A line number identifies a mutant only
 * until the next commit above it.
 */
export function originalSource(source, location) {
  const lines = String(source ?? '').split('\n')
  const { start, end } = location ?? {}
  if (start === undefined || end === undefined) return ''
  if (start.line === end.line) {
    return (lines[start.line - 1] ?? '').slice(start.column - 1, end.column - 1)
  }
  return [
    (lines[start.line - 1] ?? '').slice(start.column - 1),
    ...lines.slice(start.line, end.line - 1),
    (lines[end.line - 1] ?? '').slice(0, end.column - 1),
  ].join(' ')
}

const flatten = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()

/** The key `KNOWN_EQUIVALENT` records a settled survivor under. */
export function mutantKey(source, mutant) {
  return `${mutant.mutatorName}: ${flatten(originalSource(source, mutant.location))} -> ${flatten(mutant.replacement)}`
}

/** Survivors listed inline; the rest stay in the uploaded HTML report. */
const MAX_ROWS = 20

/** Statuses that count as a mutant the tests DETECTED. */
const DETECTED = new Set(['Killed', 'Timeout'])
/** Statuses that count against the score — everything the tests let through. */
const UNDETECTED = new Set(['Survived', 'NoCoverage'])

export function summarize(report, knownEquivalent = {}) {
  const counts = { Killed: 0, Timeout: 0, Survived: 0, NoCoverage: 0, other: 0 }
  const survivors = []
  let settled = 0
  for (const [file, entry] of Object.entries(report.files ?? {})) {
    // A ceiling per key, spent in report order: the (N+1)th of a mutation
    // recorded N times is a survivor nobody has looked at yet, and saying
    // otherwise is how a mute turns into a blind spot.
    const budget = new Map(Object.entries(knownEquivalent[file] ?? {}))
    for (const mutant of entry.mutants ?? []) {
      if (mutant.status in counts) counts[mutant.status] += 1
      else counts.other += 1
      if (mutant.status === 'Survived' || mutant.status === 'NoCoverage') {
        const key = mutantKey(entry.source, mutant)
        const left = budget.get(key) ?? 0
        if (left > 0) {
          budget.set(key, left - 1)
          settled += 1
          continue
        }
        survivors.push({
          file,
          line: mutant.location?.start?.line ?? 0,
          mutator: mutant.mutatorName ?? 'unknown',
          replacement: mutant.replacement ?? '',
          status: mutant.status,
        })
      }
    }
  }
  const detected = counts.Killed + counts.Timeout
  const undetected = counts.Survived + counts.NoCoverage
  const scored = detected + undetected
  survivors.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
  return {
    counts,
    total: scored + counts.other,
    score: scored === 0 ? null : (detected / scored) * 100,
    survivors,
    settled,
  }
}

/**
 * One table cell. A replacement is ARBITRARY SOURCE, and three characters in
 * it each end the cell early: a newline ends the row, a backtick closes the
 * code span, and a pipe splits the column — the last one even inside
 * backticks, which is the one that looks safe and is not.
 */
function cell(text) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim()
  const clipped = oneLine.length > 90 ? `${oneLine.slice(0, 89)}…` : oneLine
  return `\`${clipped.replaceAll('`', "'").replaceAll('|', '\\|')}\``
}

export function renderComment(report, marker, knownEquivalent = {}) {
  const { counts, score, survivors, settled, total } = summarize(report, knownEquivalent)
  if (total === 0) return ''

  const recorded = settled === 0 ? '' : ` · ${settled} already recorded as equivalent`
  const head =
    survivors.length === 0
      ? settled === 0
        ? `🧬 **Mutation** — ${score?.toFixed(1)}%, and nothing survived across ${total} mutants.`
        : `🧬 **Mutation** — ${score?.toFixed(1)}% across ${total} mutants. Nothing NEW survived` +
          ` — all ${settled} are already recorded as equivalent.`
      : `🧬 **Mutation** — ${score?.toFixed(1)}% · ${counts.Killed} killed · **${survivors.length} new survivor` +
        `${survivors.length === 1 ? '' : 's'}**${recorded}` +
        `${counts.Timeout > 0 ? ` · ${counts.Timeout} timed out` : ''}`

  const lines = [marker, '', head, '']
  if (survivors.length > 0) {
    lines.push(
      'A survivor is a line no test pins: the edit below can be made and nothing goes red.',
      'It is a HYPOTHESIS, not a verdict — apply the edit and run the suite before acting on it.',
      'This tool reports false survivors AND false kills, and the score has a noise floor of a',
      'mutant or so between identical runs, so read a small change as nothing. Settled cases are',
      'in `KNOWN_EQUIVALENT`; the reasoning is `package-canvas-render.md`.',
      '',
      '| where | mutator | survives as |',
      '| --- | --- | --- |',
    )
    for (const s of survivors.slice(0, MAX_ROWS)) {
      const status = s.status === 'NoCoverage' ? `${s.mutator} (no coverage)` : s.mutator
      lines.push(`| \`${s.file}:${s.line}\` | ${status} | ${cell(s.replacement)} |`)
    }
    if (survivors.length > MAX_ROWS) {
      lines.push('', `…and ${survivors.length - MAX_ROWS} more — the full report is the artifact.`)
    }
  }
  lines.push('', '_Report-only: this never blocks the merge._')
  return lines.join('\n')
}

async function main(argv) {
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const marker = flag('marker') ?? '<!-- mutation-report -->'
  const equivalentsPath = flag('equivalents')
  const named = new Set(['--marker', '--equivalents'])
  const path = argv.find((arg, i) => i > 1 && !arg.startsWith('--') && !named.has(argv[i - 1]))
  if (path === undefined) {
    process.stderr.write(
      'usage: mutation-comment.mjs <report.json> [--marker <html-comment>] [--equivalents <path>]\n',
    )
    process.exit(2)
  }
  // Imported by path like `mutation-scope.mjs` does, so this script stays a
  // repo-level tool rather than one that only knows about canvas-render.
  const { KNOWN_EQUIVALENT } =
    equivalentsPath === undefined
      ? {}
      : await import(new URL(equivalentsPath, `file://${process.cwd()}/`).href)
  const body = renderComment(JSON.parse(readFileSync(path, 'utf8')), marker, KNOWN_EQUIVALENT ?? {})
  if (body !== '') process.stdout.write(`${body}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv)
