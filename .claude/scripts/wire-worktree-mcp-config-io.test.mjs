#!/usr/bin/env node
// Regression coverage for wire-worktree-mcp.mjs's createConfigIO: the
// atomic-write pair backing ~/.claude.json reads/writes. Exercised against a
// real scratch file (never the developer-global ~/.claude.json) so the two
// guards below are checked against actual filesystem behavior instead of an
// injected fake:
//  - permission preservation across the temp-file-then-rename write
//  - refusing to overwrite a file that changed since it was last read
//
// Run with: pnpm test:scripts (also wired into the CI "check" job).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConfigIO } from './wire-worktree-mcp.mjs'

function withScratchDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wire-worktree-mcp-config-io-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("createConfigIO writeConfig preserves an existing file's mode instead of falling back to the process umask", () => {
  withScratchDir((dir) => {
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ projects: {} }))
    // Deliberately narrower than any plausible umask default so the
    // assertion can tell "preserved" apart from "coincidentally matched".
    chmodSync(configPath, 0o640)

    const { readConfig, writeConfig } = createConfigIO(configPath)
    const config = readConfig()
    writeConfig({ ...config, projects: { ...config.projects, added: true } })

    const mode = statSync(configPath).mode & 0o777
    assert.equal(mode, 0o640)
  })
})

test('createConfigIO writeConfig applies a restrictive default mode (0600) for a brand-new file', () => {
  withScratchDir((dir) => {
    const configPath = join(dir, 'config.json')
    const { readConfig, writeConfig } = createConfigIO(configPath)
    readConfig() // no file yet — establishes the "absent" snapshot
    writeConfig({ projects: {} })

    const mode = statSync(configPath).mode & 0o777
    assert.equal(mode, 0o600)
  })
})

test('createConfigIO writeConfig refuses to overwrite a file that changed since it was last read', () => {
  withScratchDir((dir) => {
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ projects: { a: 1 } }))

    const { readConfig, writeConfig } = createConfigIO(configPath)
    const config = readConfig()

    // Simulate a concurrent writer (another `claude mcp` invocation, or
    // another Claude Code session) mutating the file after our read.
    writeFileSync(configPath, JSON.stringify({ projects: { a: 1, concurrent: true } }))

    assert.throws(() => writeConfig({ ...config, projects: { ...config.projects, b: 2 } }), /changed since it was last read/)

    const survivingContent = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.deepEqual(survivingContent, { projects: { a: 1, concurrent: true } }, 'the concurrent write must not be discarded')
  })
})

test('createConfigIO writeConfig succeeds normally when nothing raced the paired read', () => {
  withScratchDir((dir) => {
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ projects: { a: 1 } }))

    const { readConfig, writeConfig } = createConfigIO(configPath)
    const config = readConfig()
    writeConfig({ ...config, projects: { ...config.projects, b: 2 } })

    const content = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.deepEqual(content, { projects: { a: 1, b: 2 } })
  })
})

test('createConfigIO writeConfig on a first write to a new file (no prior read) does not throw', () => {
  withScratchDir((dir) => {
    const configPath = join(dir, 'config.json')
    const { writeConfig } = createConfigIO(configPath)
    // No paired readConfig() call at all — lastReadRawText stays undefined,
    // so the concurrency guard must not spuriously fire.
    assert.doesNotThrow(() => writeConfig({ projects: {} }))
  })
})
