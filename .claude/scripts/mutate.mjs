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
// The file is restored from memory — on the command's exit and on SIGINT,
// SIGTERM or SIGHUP (exit 128+signo) — so neither a crash nor a Ctrl-C leaves
// the tree mutated. That is the trap that makes `git checkout --` the wrong
// restore for an UNTRACKED file, and a whole-file overwrite the wrong one
// when the tree already had other edits. SIGKILL cannot be caught: the backup
// path is printed before the command runs for that case.
//
// One run per file at a time: a second run on a file another live run holds
// exits 2 naming the holder (see `acquireLock`).
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { constants as osConstants, tmpdir } from 'node:os'
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

// Two runs on one file corrupt each other without this: the second reads the
// first's MUTATED text as its `before`, and whichever restores last writes that
// back, leaving the tree mutated with no helper alive. So the lock is taken
// before `before` is read. It lives outside the repo tree, so no `git status`
// sees it, keyed by the file's realpath, so two spellings of one path share it.
//
// The lock's content is the holder's pid, and it is created complete: written
// to a private name and `link`ed into place, which fails EEXIST atomically, so
// no reader ever sees an empty lock. A holder whose pid is dead (SIGKILL, which
// cannot release) left a stale lock, claimed by RENAMING it to a private name
// rather than unlinking it: two claimers that both saw the dead pid cannot then
// delete each other's fresh lock, because whoever renames second gets either
// ENOENT or a LIVE pid, and a live one is linked straight back. The residue is
// a three-way race inside that window, which a by-hand helper does not meet.
const lockPath = join(
  tmpdir(),
  `mutate-lock-${createHash('sha256').update(realpathSync(file)).digest('hex').slice(0, 16)}`,
)
const token = String(process.pid)

// A pid that is not a positive integer is a damaged lock, never a holder —
// and `kill(0, 0)` would answer for this whole process group.
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

function readHolder(path) {
  try {
    return Number(readFileSync(path, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

function tryLink(draft) {
  try {
    linkSync(draft, lockPath)
    return true
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
    return false
  }
}

// Moves a dead holder's lock out of the way. Answers the pid of a LIVE holder
// when another claimer replaced the stale lock between our read and our
// rename — what we took is theirs, so it goes straight back.
function claimStale() {
  const claimed = `${lockPath}.stale.${randomUUID()}`
  try {
    renameSync(lockPath, claimed)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  const taken = readHolder(claimed)
  try {
    if (taken !== null && isAlive(taken)) {
      linkSync(claimed, lockPath)
      return taken
    }
    return null
  } finally {
    unlinkSync(claimed)
  }
}

// Answers null once the lock is ours, or the pid of the live run holding it.
// It never exits itself: `process.exit` would skip the `finally` that removes
// the draft.
function acquireLock() {
  const draft = `${lockPath}.${token}.${randomUUID()}`
  writeFileSync(draft, token)
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (tryLink(draft)) return null
      const holder = readHolder(lockPath)
      if (holder === null) continue
      if (isAlive(holder)) return holder
      const live = claimStale()
      if (live !== null) return live
    }
    throw new Error(`could not take the lock at ${lockPath}`)
  } finally {
    rmSync(draft, { force: true })
  }
}

// Only this run's own lock is removed: a run that exits before taking it, or
// after another run replaced it as stale, must not delete someone else's.
function releaseLock() {
  if (readHolder(lockPath) === process.pid) unlinkSync(lockPath)
}

const holder = acquireLock()
if (holder !== null) {
  console.error(
    `mutate: ${file} is being mutated by another run (pid ${holder}); refusing to start.\n` +
      `  Its restore would race this one's. Wait for it, or if pid ${holder} is not a\n` +
      `  mutate run, remove the lock at ${lockPath}`,
  )
  process.exit(2)
}
// 'exit' also fires on `process.exit` from the signal handlers and on an
// uncaught throw, so every path out of here after this line releases.
process.on('exit', releaseLock)
console.error(`mutate: lock at ${lockPath}`)

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
// the command chmod'd the file, the disk filled — a restore that only held
// `before` would leave the tree mutated with no copy anywhere, and its
// exception would replace the command's exit code with its own. The shell
// recipe in the `diagnosis-evidence` skill uses `mktemp` + `trap` for the
// same reason.
const backupDir = mkdtempSync(join(tmpdir(), 'mutate-'))
const backup = join(backupDir, basename(file))
copyFileSync(file, backup)

// Restore is synchronous and idempotent so the signal path and the normal
// path can share it: a `finally` does not run when the process is signalled,
// and an async restore would not finish before `process.exit`.
let restored = false
function restore(status) {
  if (restored) return
  restored = true
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

// Handlers go in BEFORE the file is mutated and the command forked: a starved
// process can be descheduled between the fork and a later registration while
// the command is already running, and a signal landing in that gap kills it
// with the tree still mutated.
let child
for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(name, () => {
    // Shell convention: 128 + signal number.
    const status = 128 + osConstants.signals[name]
    // Forwarded so a wrapper (pnpm, a shell) tears its own children down; the
    // command must not outlive this process against a tree it no longer owns.
    child?.kill(name)
    restore(status)
    process.exit(process.exitCode)
  })
}

// Printed BEFORE the command runs so an unrecoverable kill (SIGKILL cannot be
// caught) still leaves a path to restore from in the terminal scrollback.
console.error(`mutate: backup at ${backup}`)
writeFileSync(file, before.split(oldText).join(newText))

// Async spawn, not spawnSync: a blocked event loop never runs a signal handler.
child = spawn(command[0], command.slice(1), { stdio: 'inherit' })
child.on('error', (err) => {
  console.error(`mutate: could not run ${command[0]}: ${err.message}`)
  restore(1)
})
child.on('close', (code) => restore(code ?? 1))
