// The helper's whole value is the path where it REFUSES, and a refusal that
// stops refusing is silent: every mutation check after it passes, against
// source nothing changed. That is the class `mutate.mjs` exists to close, so
// it is the one this file pins — the same argument `biome-plugin.test.mjs`
// makes about config regressing without a sound.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { isolatedGitEnv } from './git-test-utils.mjs'

const SCRIPT = join(import.meta.dirname, 'mutate.mjs')
const ORIGINAL = 'keep me\nthe exact line\nkeep me too\n'

function withFixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'mutate-guard-'))
  const file = join(dir, 'subject.txt')
  writeFileSync(file, ORIGINAL)
  try {
    return run(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// mutate.mjs runs git to find where its lock goes, so it gets the scratch-repo
// environment too: a hook's exported GIT_DIR would otherwise answer for it.
const mutate = (args, env = isolatedGitEnv()) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env })

test('exits 3 and names the needle when the substitution matches nothing', () => {
  withFixture((file) => {
    const run = mutate([file, 'a line that is not there', 'x', '--', process.execPath, '-e', ''])
    assert.equal(run.status, 3, run.stderr)
    assert.match(run.stderr, /NOTHING MATCHED/)
    assert.match(run.stderr, /a line that is not there/)
    // And the command never ran, so nothing can read its exit code as a result.
    assert.equal(readFileSync(file, 'utf8'), ORIGINAL)
  })
})

test('the command sees the mutated file, and the exit code comes from it', () => {
  withFixture((file) => {
    const assertMutated = `const s=require('node:fs').readFileSync(${JSON.stringify(file)},'utf8');process.exit(s.includes('the mutation')&&!s.includes('the exact line')?7:1)`
    const run = mutate([
      file,
      'the exact line',
      'the mutation',
      '--',
      process.execPath,
      '-e',
      assertMutated,
    ])
    assert.equal(run.status, 7, `command did not see the mutation\n${run.stderr}`)
    assert.match(run.stderr, /1 occurrence\(s\) replaced/)
  })
})

test('restores the file even when the command fails', () => {
  withFixture((file) => {
    const run = mutate([
      file,
      'the exact line',
      'the mutation',
      '--',
      process.execPath,
      '-e',
      'process.exit(1)',
    ])
    assert.equal(run.status, 1)
    assert.equal(readFileSync(file, 'utf8'), ORIGINAL)
  })
})

test('refuses an empty needle, which would rewrite between every character', () => {
  withFixture((file) => {
    const run = mutate([file, '', 'x', '--', process.execPath, '-e', 'process.exit(0)'])
    // 2, not 3: this is a usage error rather than a needle that missed.
    assert.equal(run.status, 2, run.stderr)
    assert.match(run.stderr, /empty/)
    assert.equal(readFileSync(file, 'utf8'), ORIGINAL)
  })
})

test('keeps a backup and exits 4 when the file cannot be restored', () => {
  withFixture((file) => {
    // The command makes the file unwritable, so the restore in `finally`
    // throws. Without a durable backup the tree would be left mutated with
    // no copy anywhere, and the thrown error would replace the command's
    // exit code with its own.
    const lock = `require('node:fs').chmodSync(${JSON.stringify(file)}, 0o444)`
    const run = mutate([file, 'the exact line', 'the mutation', '--', process.execPath, '-e', lock])
    try {
      if (run.status === 0) {
        // Running as a user the mode cannot stop (root in some containers):
        // the premise does not hold here, so say so rather than assert on it.
        assert.match(run.stderr, /restored/)
        return
      }
      assert.equal(run.status, 4, run.stderr)
      assert.match(run.stderr, /RESTORE FAILED/)
      // The recovery path is printed and the backup really is there.
      const backup = /The backup is kept at (\S+)/.exec(run.stderr)?.[1]
      assert.ok(backup, run.stderr)
      assert.equal(readFileSync(backup, 'utf8'), ORIGINAL)
    } finally {
      chmodSync(file, 0o644)
    }
  })
})

test('replaces every occurrence and says how many', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mutate-guard-'))
  const file = join(dir, 'twice.txt')
  writeFileSync(file, 'x\nx\n')
  try {
    const run = mutate([file, 'x', 'y', '--', process.execPath, '-e', ''])
    assert.match(run.stderr, /2 occurrence\(s\) replaced/)
    assert.equal(readFileSync(file, 'utf8'), 'x\nx\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// `finally` does not run when the process is signalled, so a Ctrl-C or a
// harness timeout mid-command used to leave the tree mutated with the backup
// abandoned and nothing printed. Each case signals the helper while its
// command is running and asserts the observable end state.
const signalCases = [
  ['SIGTERM', 143],
  ['SIGINT', 130],
  ['SIGHUP', 129],
]

for (const [signal, exitCode] of signalCases) {
  test(`restores the file and exits ${exitCode} when ${signal} arrives mid-command`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mutate-guard-'))
    const file = join(dir, 'subject.txt')
    const beatFile = join(dir, 'child.beat')
    writeFileSync(file, ORIGINAL)
    try {
      // The command beats a heartbeat file until killed, which outlives the
      // test's patience. A heartbeat rather than a pid probe: an orphan killed
      // under a pid 1 that never reaps stays a zombie, and `kill(pid, 0)`
      // still succeeds on one.
      const hang = `const fs=require('node:fs');const beat=()=>fs.writeFileSync(${JSON.stringify(beatFile)},String(Date.now()));beat();setInterval(beat,25);setTimeout(()=>process.exit(0),20000)`
      const helper = spawn(
        process.execPath,
        [SCRIPT, file, 'the exact line', 'the mutation', '--', process.execPath, '-e', hang],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      )
      let stderr = ''
      helper.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      const closed = new Promise((resolve) =>
        helper.on('close', (code, sig) => resolve({ code, sig })),
      )

      // Signalling before the mutation lands would test nothing, so wait for
      // the mutated file AND the command to be running.
      const deadline = Date.now() + 10_000
      while (!(existsSync(beatFile) && readFileSync(file, 'utf8').includes('the mutation'))) {
        assert.ok(Date.now() < deadline, `command never started\n${stderr}`)
        await sleep(20)
      }
      helper.kill(signal)
      // Bounded: a helper that died to the signal leaves its command holding
      // the stderr pipe, and `close` would otherwise wait on it.
      const result = await Promise.race([closed, sleep(10_000).then(() => null)])
      assert.ok(result, `helper did not exit after ${signal}\n${stderr}`)
      const { code, sig } = result

      assert.equal(readFileSync(file, 'utf8'), ORIGINAL, stderr)
      assert.equal(sig, null, `helper died to ${sig} instead of exiting`)
      assert.equal(code, exitCode, stderr)
      assert.match(stderr, /restored/)
      // A signalled helper must not orphan the command it was running: the
      // heartbeat has to stop.
      const last = readFileSync(beatFile, 'utf8')
      await sleep(300)
      assert.equal(
        readFileSync(beatFile, 'utf8'),
        last,
        'the command is still running after the helper exited',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('prints where the backup is before the command runs', () => {
  withFixture((file) => {
    const run = mutate([file, 'the exact line', 'the mutation', '--', process.execPath, '-e', ''])
    const backup = /backup at (\S+)/.exec(run.stderr)?.[1]
    assert.ok(backup, run.stderr)
    // Removed again on a clean restore, so the printed path is only a trail
    // while the run is in flight.
    assert.equal(existsSync(backup), false)
  })
})

// Two runs on one file used to corrupt each other: the second read the first's
// MUTATED text as its "before", and whichever restored last wrote that back, so
// the tree stayed mutated with no helper alive. A second run must refuse before
// it reads anything.
async function assertSecondRunRefused({
  inRepo = false,
  secondTmpdir = null,
  secondExtraEnv = null,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mutate-guard-'))
  if (inRepo) {
    const init = spawnSync('git', ['init', '--quiet', dir], {
      encoding: 'utf8',
      env: isolatedGitEnv(),
    })
    assert.equal(init.status, 0, init.stderr)
  }
  const file = join(dir, 'subject.txt')
  const started = join(dir, 'first.started')
  const release = join(dir, 'first.release')
  const secondRan = join(dir, 'second.ran')
  writeFileSync(file, ORIGINAL)
  let first
  try {
    // Blocks on a file the test creates, not on a timer.
    const block = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(started)},'');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(t)}},20)`
    first = spawn(
      process.execPath,
      [SCRIPT, file, 'the exact line', 'the mutation', '--', process.execPath, '-e', block],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let firstStderr = ''
    first.stderr.on('data', (chunk) => {
      firstStderr += chunk
    })
    const firstClosed = new Promise((resolve) => first.on('close', (code) => resolve(code)))
    const deadline = Date.now() + 10_000
    while (!existsSync(started)) {
      assert.ok(Date.now() < deadline, `first run never started\n${firstStderr}`)
      await sleep(20)
    }

    // A needle the first mutation leaves intact, so only the lock can refuse.
    const mark = `require('node:fs').writeFileSync(${JSON.stringify(secondRan)},'')`
    const secondEnv =
      secondTmpdir === null && secondExtraEnv === null
        ? undefined
        : isolatedGitEnv({
            ...(secondTmpdir === null ? {} : { TMPDIR: secondTmpdir }),
            ...secondExtraEnv?.(),
          })
    const second = mutate(
      [file, 'keep me too', 'other', '--', process.execPath, '-e', mark],
      secondEnv,
    )
    assert.equal(second.status, 2, second.stderr)
    assert.match(second.stderr, new RegExp(`pid ${first.pid}\\b`))
    assert.ok(second.stderr.includes(file), second.stderr)
    if (inRepo) {
      // The clone's own git dir, not the system-temp fallback.
      const lockDir = join(realpathSync(dir), '.git', 'mutate-locks')
      assert.ok(second.stderr.includes(lockDir), second.stderr)
    }
    assert.equal(existsSync(secondRan), false, 'the refused run still ran its command')

    writeFileSync(release, '')
    assert.equal(await firstClosed, 0, firstStderr)
    assert.equal(readFileSync(file, 'utf8'), ORIGINAL)
  } finally {
    // A failed assertion above must not leave the blocked run alive.
    first?.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
}

test('refuses a second run on a file another live run is mutating', () => assertSecondRunRefused())

// `os.tmpdir()` follows $TMPDIR, and a private TMPDIR per run is routine here,
// so a lock under it is a lock per (file, TMPDIR): both runs mutate, and the
// later restore writes the earlier mutation back.
for (const inRepo of [true, false]) {
  test(`refuses a second run under a different TMPDIR (${inRepo ? 'in a git repo' : 'outside one'})`, async () => {
    const otherTmp = mkdtempSync(join(tmpdir(), 'mutate-other-tmp-'))
    try {
      await assertSecondRunRefused({ inRepo, secondTmpdir: otherTmp })
    } finally {
      rmSync(otherTmp, { recursive: true, force: true })
    }
  })
}

// A git hook exports GIT_DIR for the repository it runs in, and `rev-parse
// --git-common-dir` answers from it rather than from the file's own clone. A
// run inheriting one would claim a lock in another repository.
test("refuses a second run that inherited another repository's GIT_DIR", async () => {
  const other = mkdtempSync(join(tmpdir(), 'mutate-other-repo-'))
  try {
    const init = spawnSync('git', ['init', '--quiet', other], {
      encoding: 'utf8',
      env: isolatedGitEnv(),
    })
    assert.equal(init.status, 0, init.stderr)
    await assertSecondRunRefused({
      inRepo: true,
      secondExtraEnv: () => ({ GIT_DIR: join(other, '.git') }),
    })
  } finally {
    rmSync(other, { recursive: true, force: true })
  }
})

test('replaces a lock left by a run that died without releasing it', () => {
  withFixture((file) => {
    const probe = mutate([file, 'the exact line', 'x', '--', process.execPath, '-e', ''])
    const lockPath = /lock at (\S+)/.exec(probe.stderr)?.[1]
    assert.ok(lockPath, probe.stderr)
    assert.equal(existsSync(lockPath), false, 'a finished run left its lock behind')

    // A pid that has exited and been reaped, as a SIGKILLed run's would be.
    const dead = spawnSync(process.execPath, ['-e', '']).pid
    writeFileSync(lockPath, String(dead))
    try {
      const run = mutate([
        file,
        'the exact line',
        'x',
        '--',
        process.execPath,
        '-e',
        'process.exit(5)',
      ])
      assert.equal(run.status, 5, run.stderr)
      assert.equal(readFileSync(file, 'utf8'), ORIGINAL)
      assert.equal(existsSync(lockPath), false, 'the replaced lock was not released')
    } finally {
      rmSync(lockPath, { force: true })
    }
  })
})
