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
// exits 2 naming the holder (see the lock below).
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { constants as osConstants, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { isPidFileWriter } from '../../packages/mcp-server/scripts/dev/dev-daemon-socket-lib.mjs'
import {
  claimPidFile,
  releasePidFile,
} from '../../packages/mcp-server/scripts/dev/dev-spawn-lock-lib.mjs'

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
// before `before` is read. It is keyed by the file's realpath, so two spellings
// of one path share it, and it lives where $TMPDIR cannot move it: under
// `os.tmpdir()` two runs with different TMPDIRs each took their own lock on one
// file and corrupted it exactly as above, and a private TMPDIR per run is
// routine. Inside a git clone it sits in the common git dir — one place for
// every worktree of the clone, and never seen by `git status`. Outside any
// clone it falls back to the system temp dir, which on POSIX is `/tmp`
// whatever $TMPDIR says.
//
// The lock is a pid file claimed the way the dev wrapper claims its own
// (`claimPidFile`): created exclusively, and a holder that is gone (SIGKILL,
// which cannot release) or whose pid a later process has taken is replaced
// through a rename claim that two racing claimers cannot both win. Importing it
// does not stop this helper mutating that lib: the import is evaluated before
// the substitution is written.
const lockPath = resolveLockPath(realpathSync(file))

function resolveLockPath(realFile) {
  const key = createHash('sha256').update(realFile).digest('hex').slice(0, 16)
  const git = spawnSync(
    'git',
    ['-C', dirname(realFile), 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8' },
  )
  const commonDir = git.status === 0 ? git.stdout.trim() : ''
  if (commonDir !== '') {
    const lockDir = join(commonDir, 'mutate-locks')
    mkdirSync(lockDir, { recursive: true })
    return join(lockDir, key)
  }
  return join(process.platform === 'win32' ? tmpdir() : '/tmp', `mutate-lock-${key}`)
}

const claim = claimPidFile({ pidPath: lockPath, pid: process.pid, isWriterAlive: isPidFileWriter })
if (claim.kind === 'held') {
  const holder = claim.pid === null ? 'a run whose pid could not be read' : `pid ${claim.pid}`
  console.error(
    `mutate: ${file} is being mutated by another run (${holder}); refusing to start.\n` +
      `  Its restore would race this one's. Wait for it, or if ${holder} is not a\n` +
      `  mutate run, remove the lock at ${lockPath}`,
  )
  process.exit(2)
}
// Only this run's own lock is removed, and never with a throw: it runs in the
// exit handler, where a crash would overwrite a restored run's exit code.
const releaseLock = () => releasePidFile({ pidPath: lockPath, pid: process.pid })
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
