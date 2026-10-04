#!/usr/bin/env node
// Run with: pnpm test:scripts
import assert from 'node:assert/strict'
import { test } from 'node:test'
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
