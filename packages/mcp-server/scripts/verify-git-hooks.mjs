#!/usr/bin/env node
/**
 * Detects — and optionally repairs — installed git hooks whose exit status is
 * no longer lefthook's.
 *
 * lefthook generates a hook script ending in `call_lefthook run "<hook>" "$@"`.
 * That call's status IS the script's status, which is what makes a failing
 * pre-commit command block the commit. A tool that APPENDS its own block to
 * the same file (code-review-graph installs this way) makes its own last
 * command the script's status instead — and such blocks typically end in
 * `|| true`, so every lefthook gate silently becomes advisory while still
 * printing its failure. The gate looks like it works right up until it
 * matters.
 *
 * Usage:
 *   node verify-git-hooks.mjs          # report; exit 1 when a hook is broken
 *   node verify-git-hooks.mjs --fix    # move appended blocks ahead of lefthook
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** The line lefthook's generated script ends with. */
const LEFTHOOK_CALL = /^call_lefthook run .*$/m

/**
 * The executable commands sitting after lefthook's invocation, in order.
 * Empty when the hook is well-formed, or when lefthook does not manage it at
 * all. Comments and blank lines are ignored — they cannot change an exit
 * status, and a shebang line after the first is only a comment.
 */
export function findCommandsAfterLefthook(script) {
  const match = LEFTHOOK_CALL.exec(script)
  if (match === null) return []
  const tail = script.slice(match.index + match[0].length)
  return tail
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

/**
 * Moves an appended block ahead of lefthook's invocation, so lefthook runs
 * last and git sees its status. Returns the repaired script, or null when
 * there is nothing to repair.
 */
export function hoistAppendedBlock(script) {
  const match = LEFTHOOK_CALL.exec(script)
  if (match === null) return null
  const callEnd = match.index + match[0].length
  const head = script.slice(0, match.index)
  const call = match[0]
  const tail = script.slice(callEnd)
  if (findCommandsAfterLefthook(script).length === 0) return null
  return `${head}${tail.replace(/^\n+/, '')}\n${call}\n`
}

function main(argv) {
  const repoRoot = resolve(import.meta.dirname, '../../../')
  const hooksDir = join(repoRoot, '.git', 'hooks')
  if (!existsSync(hooksDir)) {
    process.stdout.write('no .git/hooks directory — nothing to verify\n')
    return 0
  }
  const shouldFix = argv.includes('--fix')
  let broken = 0
  for (const name of readdirSync(hooksDir).filter((n) => !n.endsWith('.sample'))) {
    const path = join(hooksDir, name)
    const script = readFileSync(path, 'utf8')
    const extra = findCommandsAfterLefthook(script)
    if (extra.length === 0) continue
    broken += 1
    process.stdout.write(
      `.git/hooks/${name} runs after lefthook, so git sees THIS exit status:\n` +
        extra.map((line) => `    ${line}\n`).join(''),
    )
    if (shouldFix) {
      const repaired = hoistAppendedBlock(script)
      if (repaired !== null) {
        writeFileSync(path, repaired)
        process.stdout.write(`  fixed: moved ahead of lefthook\n`)
        broken -= 1
      }
    }
  }
  if (broken > 0) {
    process.stdout.write('\nRun with --fix to repair, then re-run to confirm.\n')
    return 1
  }
  process.stdout.write('git hooks preserve lefthook exit status\n')
  return 0
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  process.exit(main(process.argv.slice(2)))
}
