#!/usr/bin/env node
// Picks the `--mutate` value for a PR: the files this diff changed, narrowed
// to the ones the lane curates.
//
//   node .claude/scripts/mutation-scope.mjs --targets <stryker-targets.mjs> \
//     --prefix packages/canvas-render/ [--changed-from <file>]
//
// It reads the target LIST rather than the Stryker config on purpose: the
// config resolves its plugin at load time, so importing it would make this
// step need an install, on every PR, just to find out there is nothing to do.
//
// Prints a comma-separated list of package-relative paths, or NOTHING when the
// diff reaches none of them — which is most diffs, and the reason the PR job
// can skip itself instead of paying for a run with nothing to say.
//
// The curated list is what keeps the PR signal trustworthy: mutating whatever
// a diff happens to touch would drag in files the lane deliberately excludes
// (`seed.ts`, whose survivors are known to be false) and files no property
// pins, whose survivors are true but not news.

import { readFileSync } from 'node:fs'

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

async function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const targetsPath = arg('targets')
  const prefix = arg('prefix')
  if (targetsPath === undefined || prefix === undefined) {
    process.stderr.write('usage: mutation-scope.mjs --targets <path> --prefix <path> [--changed-from <file>]\n')
    process.exit(2)
  }
  const changedFrom = arg('changed-from')
  const changed = (
    changedFrom === undefined ? readFileSync(0, 'utf8') : readFileSync(changedFrom, 'utf8')
  ).split('\n')
  const { MUTATED } = await import(new URL(targetsPath, `file://${process.cwd()}/`).href)
  const scoped = scopeToDiff(MUTATED ?? [], changed, prefix)
  if (scoped.length > 0) process.stdout.write(`${scoped.join(',')}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv)
