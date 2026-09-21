#!/usr/bin/env node
// Apply one mutation, run a command, restore — and FAIL LOUDLY when the
// substitution matched nothing.
//
// A mutation check is only evidence if the mutation happened, and the
// failure mode is silent: `String.replace` with a needle that is not there
// returns the input unchanged, the command runs against untouched source,
// and the guard passes. That reads exactly like a guard that checked.
// Measured twice in one session — a probe spelled a ledger entry with double
// quotes after the formatter had rewritten the file to single, and two of
// four "mutation checks" had never run.
//
//   node .claude/scripts/mutate.mjs <file> <old> <new> -- <command...>
//
// Exit code is the command's, so an EXPECTED failure is read by the caller:
//   ... -- pnpm vitest run --project mcp-node my-guard   # expect non-zero
//
// The file is restored from memory in a `finally`, so a crash mid-command
// does not leave the tree mutated — the trap that makes `git checkout --`
// the wrong restore for an UNTRACKED file, and a whole-file overwrite the
// wrong one when the tree already had other edits.
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const split = argv.indexOf('--')
if (split < 3) {
  console.error('usage: mutate.mjs <file> <old> <new> -- <command...>')
  process.exit(2)
}
const [file, oldText, newText] = argv.slice(0, split)
const command = argv.slice(split + 1)
if (command.length === 0) {
  console.error('usage: mutate.mjs <file> <old> <new> -- <command...>')
  process.exit(2)
}

const before = readFileSync(file, 'utf8')
const occurrences = before.split(oldText).length - 1
if (occurrences === 0) {
  console.error(
    `mutate: NOTHING MATCHED in ${file}\n` +
      `  looking for: ${JSON.stringify(oldText)}\n` +
      '  The mutation never applied, so whatever the command answers says ' +
      'nothing about the guard. Check quoting and formatting — a formatter ' +
      'may have rewritten the line since you read it.',
  )
  process.exit(3)
}
console.error(`mutate: ${file} — ${occurrences} occurrence(s) replaced`)

try {
  writeFileSync(file, before.split(oldText).join(newText))
  const run = spawnSync(command[0], command.slice(1), { stdio: 'inherit' })
  process.exitCode = run.status ?? 1
} finally {
  writeFileSync(file, before)
  console.error(`mutate: ${file} restored`)
}
