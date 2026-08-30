#!/usr/bin/env node
// Renders a Stryker JSON report as the sticky PR comment body.
//
// The lane this serves is REPORT-ONLY, which makes visibility its whole
// problem: a weekly HTML artifact is a number nobody opens, and a survivor
// nobody reads is the same as no lane at all. So the numbers go where the
// author already is.
//
//   node .claude/scripts/mutation-comment.mjs <report.json> [--marker <html-comment>]
//
// Prints markdown to stdout, or NOTHING when the report holds no mutants —
// the common case, since most diffs touch none of the mutated modules, and a
// comment saying "nothing to say" is the noise that gets bots muted.

import { readFileSync } from 'node:fs'

/** Survivors listed inline; the rest stay in the uploaded HTML report. */
const MAX_ROWS = 20

/** Statuses that count as a mutant the tests DETECTED. */
const DETECTED = new Set(['Killed', 'Timeout'])
/** Statuses that count against the score — everything the tests let through. */
const UNDETECTED = new Set(['Survived', 'NoCoverage'])

export function summarize(report) {
  const counts = { Killed: 0, Timeout: 0, Survived: 0, NoCoverage: 0, other: 0 }
  const survivors = []
  for (const [file, entry] of Object.entries(report.files ?? {})) {
    for (const mutant of entry.mutants ?? []) {
      if (mutant.status in counts) counts[mutant.status] += 1
      else counts.other += 1
      if (mutant.status === 'Survived' || mutant.status === 'NoCoverage') {
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

export function renderComment(report, marker) {
  const { counts, score, survivors, total } = summarize(report)
  if (total === 0) return ''

  const head =
    survivors.length === 0
      ? `🧬 **Mutation** — ${score?.toFixed(1)}%, and nothing survived across ${total} mutants.`
      : `🧬 **Mutation** — ${score?.toFixed(1)}% · ${counts.Killed} killed · **${counts.Survived} survived**` +
        `${counts.NoCoverage > 0 ? ` · ${counts.NoCoverage} not covered` : ''}` +
        `${counts.Timeout > 0 ? ` · ${counts.Timeout} timed out` : ''}`

  const lines = [marker, '', head, '']
  if (survivors.length > 0) {
    lines.push(
      'A survivor is a line no test pins: the edit below can be made and nothing goes red.',
      'It is a HYPOTHESIS, not a verdict — apply the edit and run the suite before acting on',
      'it, because this tool can report a false survivor (see `package-canvas-render.md`).',
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

function main(argv) {
  const markerIndex = argv.indexOf('--marker')
  const marker = markerIndex >= 0 ? argv[markerIndex + 1] : '<!-- mutation-report -->'
  const path = argv.find((arg, i) => i > 1 && !arg.startsWith('--') && argv[i - 1] !== '--marker')
  if (path === undefined) {
    process.stderr.write('usage: mutation-comment.mjs <report.json> [--marker <html-comment>]\n')
    process.exit(2)
  }
  const body = renderComment(JSON.parse(readFileSync(path, 'utf8')), marker)
  if (body !== '') process.stdout.write(`${body}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv)
