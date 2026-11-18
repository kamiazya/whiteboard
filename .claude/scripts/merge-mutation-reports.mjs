#!/usr/bin/env node
// Merges the mutation lane's per-leg Stryker reports into one.
//
// usage: merge-mutation-reports.mjs <out.json> <leg.json>...
//
// Each leg mutates a disjoint set of files, so concatenating the `files` and
// `testFiles` maps is the whole merge; every other top-level key is the same in
// every leg and is taken from the first.
//
// Node rather than jq: a report embeds test sources verbatim, and a test about
// lone surrogates carries `\ud800` — legal JSON that jq refuses outright.

import { readFileSync, writeFileSync } from 'node:fs'
import { isRunAsScript } from '../../tools/checks/src/is-run-as-script.mjs'

export function mergeReports(reports) {
  return {
    ...reports[0],
    files: Object.assign({}, ...reports.map((r) => r.files)),
    testFiles: Object.assign({}, ...reports.map((r) => r.testFiles ?? {})),
  }
}

function main([out, ...legs]) {
  if (out === undefined || legs.length === 0) {
    process.stderr.write('usage: merge-mutation-reports.mjs <out.json> <leg.json>...\n')
    process.exit(2)
  }
  const merged = mergeReports(legs.map((leg) => JSON.parse(readFileSync(leg, 'utf8'))))
  writeFileSync(out, JSON.stringify(merged))
  process.stdout.write(
    `merged ${Object.keys(merged.files).length} files from ${legs.length} legs\n`,
  )
}

if (isRunAsScript(import.meta.url)) main(process.argv.slice(2))
