/**
 * Contract tests asserting the invariants between the two data-dir resolvers:
 *   - resolveDefaultDataDir (daemon/data-dir.ts): PURE PROBE, no side-effects.
 *   - resolveDataDir (shared/data-dir-secure.ts): CREATE+SECURE, mkdirSync for home candidate only.
 *
 * Steady-state invariant: once ~/.whiteboard exists and is writable, both resolvers
 * agree on the same path.
 *
 * Deliberate first-run difference: before the server has created ~/.whiteboard,
 * the probe falls back to tmp while the create-side produces ~/.whiteboard via mkdir.
 * After the server creates the dir, re-probing converges both to home.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveDefaultDataDir } from '../daemon/data-dir.js'
import { resolveDataDir, WHITEBOARD_ROOT, DATA_DIR } from './data-dir-secure.js'

describe('data-dir contract: probe and create resolvers agree in steady state', () => {
  let tempHome: string
  let tempTmp: string
  // Both resolvers take the same { homeDir, tmpDir } overrides so the test
  // drives the real branch logic against temp dirs instead of the real $HOME.
  let dirs: { homeDir: string; tmpDir: string }

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'dd-contract-home-'))
    tempTmp = await mkdtemp(join(tmpdir(), 'dd-contract-tmp-'))
    dirs = { homeDir: tempHome, tmpDir: tempTmp }
  })

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true })
    await rm(tempTmp, { recursive: true, force: true })
  })

  it('steady state: both resolvers return the same home path when ~/.whiteboard exists and is writable', async () => {
    // Arrange: pre-create ~/.whiteboard (steady state — server already ran once)
    const homeWhiteboard = join(tempHome, '.whiteboard')
    await mkdir(homeWhiteboard)

    // Act: probe (no side-effects)
    const probeResult = resolveDefaultDataDir({}, { ...dirs, checkWritable: undefined })

    // Act: create-side (may call mkdir, but dir already exists so it's idempotent)
    const createResult = resolveDataDir({}, dirs)

    // Assert: both agree
    expect(probeResult).toBe(homeWhiteboard)
    expect(createResult).toBe(homeWhiteboard)
    expect(probeResult).toBe(createResult)
  })

  it('env override: both resolvers return the same absolute env-override path', () => {
    const override = resolve(tempHome, 'custom-data')
    const env = { WHITEBOARD_DATA_DIR: override }

    // Neither resolver should call canWriteDir / checkWritable for the override branch.
    let createSideCheckCalled = false
    const createResult = resolveDataDir(env, {
      ...dirs,
      isWritableDir: () => {
        createSideCheckCalled = true
        return true
      },
    })

    let probeSideCheckCalled = false
    const probeResult = resolveDefaultDataDir(env, {
      ...dirs,
      checkWritable: () => {
        probeSideCheckCalled = true
        return true
      },
    })

    // Both resolvers return the override, bypass mkdir/checkWritable
    expect(createResult).toBe(override)
    expect(probeResult).toBe(override)
    expect(createResult).toBe(probeResult)

    // The override branch must NOT call canWriteDir / checkWritable
    expect(createSideCheckCalled).toBe(false)
    expect(probeSideCheckCalled).toBe(false)
  })

  it('documented first-run divergence: probe→tmp before server creates home, then both converge after', async () => {
    // Arrange: NO ~/.whiteboard yet (first run)
    const homeWhiteboard = join(tempHome, '.whiteboard')

    // The probe uses real filesystem check — ~/.whiteboard doesn't exist → falls to tmp
    const probeBeforeCreate = resolveDefaultDataDir({}, dirs)
    expect(probeBeforeCreate).toBe(join(tempTmp, '.whiteboard'))

    // The create-side resolver calls canWriteDir(homeCandidate) which does mkdirSync → home
    const createResult = resolveDataDir({}, dirs)
    expect(createResult).toBe(homeWhiteboard)

    // After the server creates the dir, re-probing finds it and now agrees with create
    const probeAfterCreate = resolveDefaultDataDir({}, dirs)
    expect(probeAfterCreate).toBe(homeWhiteboard)
    expect(probeAfterCreate).toBe(createResult)
  })

  it('tmp-fallback side-effect scope: create falls to tmp with NO mkdir on the tmp path itself', () => {
    // When home is not writable, canWriteDir returns false and we return tmp WITHOUT
    // creating or hardening it. The create-side isWritableDir stub proves this.
    let mkdirCalledOnTmp = false

    const tmpWhiteboard = join(tempTmp, '.whiteboard')

    const result = resolveDataDir(
      {},
      {
        ...dirs,
        isWritableDir: (p) => {
          // Home candidate: simulate not writable so the resolver falls back to tmp.
          // Record if it is ever (wrongly) called on the tmp path.
          if (p === tmpWhiteboard) {
            mkdirCalledOnTmp = true
          }
          return false
        },
      },
    )

    expect(result).toBe(tmpWhiteboard)
    // The tmp-fallback branch must NOT call canWriteDir on the tmp path
    expect(mkdirCalledOnTmp).toBe(false)
  })

  it('home-is-a-regular-file edge: both resolvers fall back to tmp', async () => {
    // When ~/.whiteboard is a file (not a directory), both resolvers must agree on tmp
    const homeWhiteboard = join(tempHome, '.whiteboard')
    await writeFile(homeWhiteboard, 'not a directory')

    const probeResult = resolveDefaultDataDir({}, dirs)
    const createResult = resolveDataDir({}, dirs)

    const expectedTmp = join(tempTmp, '.whiteboard')
    expect(probeResult).toBe(expectedTmp)
    expect(createResult).toBe(expectedTmp)
  })
})

describe('WHITEBOARD_ROOT depth: shared module resolves to package root', () => {
  it('WHITEBOARD_ROOT points to the package root (dir containing package.json)', () => {
    // WHITEBOARD_ROOT is resolve(import.meta.url-dir, '../..').
    // From src/shared, '../..' = src/shared/../../ = package root. Verify explicitly.
    expect(existsSync(join(WHITEBOARD_ROOT, 'package.json'))).toBe(true)
  })

  it('DATA_DIR is exported from shared/data-dir-secure.ts (module imports work)', () => {
    // If the re-export chain is broken this import itself would throw.
    expect(typeof DATA_DIR).toBe('string')
    expect(DATA_DIR.length).toBeGreaterThan(0)
  })
})
