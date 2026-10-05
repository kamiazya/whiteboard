#!/usr/bin/env node
// Picks the `--mutate` value for a PR: the files this diff changed, narrowed
// to the ones the lane curates.
//
//   node .claude/scripts/mutation-scope.mjs --targets <stryker-targets.mjs> \
//     --prefix packages/canvas-render/ [--changed-from <file>] [--legs <n>]
//
// It reads the target LIST rather than the Stryker config on purpose: the
// config resolves its plugin at load time, so importing it would make this
// step need an install, on every PR, just to find out there is nothing to do.
//
// Prints a comma-separated list of package-relative paths, or NOTHING when the
// diff reaches none of them — which is most diffs, and the reason the PR job
// can skip itself instead of paying for a run with nothing to say.
//
// With `--legs <n>` it prints a job matrix instead: a JSON array of
// `{ shard, files }`, one per leg of an n-leg full run that holds a changed
// file, and `[]` when none does. Each PR leg then mutates a subset of one
// full-run leg, so it cannot outlast it, and the PR job can be sized from
// the full run's measurement rather than from a guess about the diff.
//
// The curated list is what keeps the PR signal trustworthy: mutating whatever
// a diff happens to touch would drag in files the lane deliberately excludes
// (`seed.ts`, whose survivors are known to be false) and files no property
// pins, whose survivors are true but not news.

import { readFileSync } from 'node:fs'
import { isRunAsScript } from '../../tools/checks/src/is-run-as-script.mjs'

/** A glob in `mutate` cannot be intersected by string equality, and silently
 * matching nothing would look exactly like "this diff changed nothing". */
export function scopeToDiff(mutateEntries, changedPaths, prefix) {
  const globbed = mutateEntries.filter((entry) => /[*?[\]{}]/.test(entry))
  if (globbed.length > 0) {
    throw new Error(
      `mutation-scope cannot intersect a glob pattern: ${globbed.join(', ')}. ` +
        'Either list the file literally, or teach this script to match globs — ' +
        'silently scoping to nothing is the failure worth avoiding here.',
    )
  }
  const curated = new Set(mutateEntries)
  const changed = new Set(
    changedPaths
      .map((line) => line.trim())
      .filter((line) => line.startsWith(prefix))
      .map((line) => line.slice(prefix.length)),
  )
  return mutateEntries.filter((entry) => changed.has(entry) && curated.has(entry))
}

/**
 * The changed files grouped by the leg `shardOf` deals each to in an `n`-leg
 * run over the whole list, leaving out the legs that hold none.
 */
export function legsOf(scoped, mutateEntries, shardOf, legs) {
  const changed = new Set(scoped)
  return Array.from({ length: legs }, (_, index) => ({
    shard: index + 1,
    files: shardOf(mutateEntries, `${index + 1}/${legs}`).filter((file) => changed.has(file)),
  }))
    .filter((leg) => leg.files.length > 0)
    .map((leg) => ({ shard: leg.shard, files: leg.files.join(',') }))
}

async function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const targetsPath = arg('targets')
  const prefix = arg('prefix')
  if (targetsPath === undefined || prefix === undefined) {
    process.stderr.write(
      'usage: mutation-scope.mjs --targets <path> --prefix <path> [--changed-from <file>]\n',
    )
    process.exit(2)
  }
  const changedFrom = arg('changed-from')
  const changed = (
    changedFrom === undefined ? readFileSync(0, 'utf8') : readFileSync(changedFrom, 'utf8')
  ).split('\n')
  const { MUTATED, shardOf } = await import(new URL(targetsPath, `file://${process.cwd()}/`).href)
  const scoped = scopeToDiff(MUTATED ?? [], changed, prefix)
  const legs = arg('legs')
  if (legs !== undefined) {
    // A count that parses to nothing would deal every file to no leg, and an
    // empty matrix reads exactly like a diff with nothing to mutate.
    if (!/^[1-9]\d*$/.test(legs)) {
      process.stderr.write(`--legs must be a positive integer, got "${legs}"\n`)
      process.exit(2)
    }
    process.stdout.write(`${JSON.stringify(legsOf(scoped, MUTATED, shardOf, Number(legs)))}\n`)
  } else if (scoped.length > 0) {
    process.stdout.write(`${scoped.join(',')}\n`)
  }
}

if (isRunAsScript(import.meta.url)) await main(process.argv)
