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
// Exit code is the command's (or 4 when the file could not be restored, in
// which case the command's result is not reportable), so an EXPECTED failure
// is read by the caller:
//   ... -- pnpm vitest run --project mcp-node my-guard   # expect non-zero
//
// The file is restored from memory in a `finally`, so a crash mid-command
// does not leave the tree mutated — the trap that makes `git checkout --`
// the wrong restore for an UNTRACKED file, and a whole-file overwrite the
// wrong one when the tree already had other edits.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

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

// An EMPTY needle passes the occurrence check on any non-empty file —
// `split('')` answers one segment per character — and then inserts `newText`
// between every character. The command would run against a whole-file
// mutation nobody asked for, which is this helper's failure mode inverted.
if (oldText === '') {
  console.error('mutate: <old> is empty, which would rewrite the file between every character')
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

// A backup ON DISK, not only the string in memory: if the restore throws —
// the command chmod'd the file, the disk filled — a `finally` that only held
// `before` would leave the tree mutated with no copy anywhere, and its
// exception would replace the command's exit code with its own. The shell
// recipe in the `diagnosis-evidence` skill uses `mktemp` + `trap` for the
// same reason.
const backupDir = mkdtempSync(join(tmpdir(), 'mutate-'))
const backup = join(backupDir, basename(file))
copyFileSync(file, backup)

let status = 1
try {
  writeFileSync(file, before.split(oldText).join(newText))
  const run = spawnSync(command[0], command.slice(1), { stdio: 'inherit' })
  status = run.status ?? 1
} finally {
  try {
    writeFileSync(file, before)
    rmSync(backupDir, { recursive: true, force: true })
    console.error(`mutate: ${file} restored`)
    process.exitCode = status
  } catch (err) {
    // Keep the backup and say where it is. The command's own result is not
    // reportable any more — the tree it ran against is still mutated — so
    // this exits non-zero on its own rather than passing a green through.
    console.error(
      `mutate: RESTORE FAILED for ${file}: ${err instanceof Error ? err.message : String(err)}\n` +
        `  The file is still MUTATED. Restore it by hand:\n` +
        `    cp ${backup} ${file}\n` +
        `  The backup is kept at ${backup} and is not cleaned up.`,
    )
    process.exitCode = 4
  }
}
