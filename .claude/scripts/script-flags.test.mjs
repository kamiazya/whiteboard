#!/usr/bin/env node
// Run with: pnpm test:scripts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseScriptArgs } from './script-flags.mjs'

class Exited extends Error {
  constructor(code) {
    super(`exit ${code}`)
    this.code = code
  }
}

function run(argv, options = {}) {
  const out = []
  const err = []
  const io = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    exit: (code) => {
      throw new Exited(code)
    },
  }
  try {
    const parsed = parseScriptArgs({
      argv,
      usage: 'usage: x [--go]',
      flags: ['--go'],
      ...options,
      io,
    })
    return { parsed, out, err }
  } catch (error) {
    if (!(error instanceof Exited)) throw error
    return { code: error.code, out, err }
  }
}

test('known flags and positionals are returned, with no output', () => {
  const { parsed, out, err } = run(['--go', 'target'], { maxPositionals: 1 })
  assert.deepEqual([...parsed.flags], ['--go'])
  assert.deepEqual(parsed.positionals, ['target'])
  assert.deepEqual([out, err], [[], []])
})

test('an unknown flag prints the usage on stderr and exits 2', () => {
  for (const bogus of ['--bogus', '--dryrun', '-n']) {
    const result = run(['--go', bogus])
    assert.equal(result.code, 2, bogus)
    assert.match(result.err.join(''), new RegExp(`unknown option ${bogus}`))
    assert.match(result.err.join(''), /usage: x/)
    assert.deepEqual(result.out, [])
  }
})

test('--help and -h print the usage on stdout and exit 0, wherever they sit', () => {
  for (const argv of [['--help'], ['-h'], ['--go', '--help'], ['--bogus', '--help']]) {
    const result = run(argv)
    assert.equal(result.code, 0, argv.join(' '))
    assert.match(result.out.join(''), /usage: x/)
    assert.deepEqual(result.err, [])
  }
})

test('a positional beyond the allowance is refused, and a lone "-" counts as a positional (stdin)', () => {
  assert.equal(run(['a']).code, 2)
  assert.equal(run(['a', 'b'], { maxPositionals: 1 }).code, 2)
  assert.deepEqual(run(['-'], { maxPositionals: 1 }).parsed.positionals, ['-'])
})

const SCRIPT_FLAGS = fileURLToPath(new URL('./script-flags.mjs', import.meta.url))

function withScratch(body) {
  const dir = mkdtempSync(join(tmpdir(), 'script-flags-'))
  try {
    return body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function node(args) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

const PROBE = `import { isRunAsScript } from ${JSON.stringify(SCRIPT_FLAGS)}
console.log(isRunAsScript(import.meta.url))
`

test('isRunAsScript is true for the entry module, also when it is reached through a symlink', () => {
  withScratch((dir) => {
    writeFileSync(join(dir, 'probe.mjs'), PROBE)
    symlinkSync(join(dir, 'probe.mjs'), join(dir, 'link.mjs'))
    assert.equal(node([join(dir, 'probe.mjs')]), 'true')
    assert.equal(node([join(dir, 'link.mjs')]), 'true')
  })
})

test('isRunAsScript is false for a module something else imported', () => {
  withScratch((dir) => {
    writeFileSync(join(dir, 'probe.mjs'), PROBE)
    writeFileSync(join(dir, 'entry.mjs'), "import './probe.mjs'\n")
    assert.equal(node([join(dir, 'entry.mjs')]), 'false')
  })
})

test('isRunAsScript is false with no entry script at all', () => {
  const probe = PROBE.replace('import.meta.url', "'file:///x.mjs'")
  assert.equal(node(['--input-type=module', '-e', probe]), 'false')
})
