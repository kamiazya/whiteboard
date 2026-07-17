// Unit coverage for the shared release-gate-matrix validator
// (tools/checks/src/release-gate-matrix-schema.mjs). This is the SINGLE
// validation authority: release-gate-matrix.test.ts imports the same module
// instead of re-implementing validateGate, so the two can never drift apart.

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../../../..')
const SCHEMA_MODULE = join(ROOT, 'tools/checks/src/release-gate-matrix-schema.mjs')

async function importSchema() {
  const mod = await import(pathToFileURL(SCHEMA_MODULE).href)
  return mod as {
    validateGate: (gate: unknown) => { ok: boolean; reason?: string }
    validateMatrix: (matrix: unknown) => { ok: boolean; reason?: string }
    validatePrCoverage: (prCoverage: unknown) => { ok: boolean; reason?: string }
    validateGateEnv?: (env: unknown) => { ok: boolean; reason?: string }
  }
}

const VALID_GATE = {
  id: 'test',
  command: 'pnpm test',
  category: 'unit',
  requiredFor: ['ci'],
  requiresDocker: false,
  requiresNetwork: false,
  expectedRuntimeBucket: 'fast',
}

describe('validateGate', () => {
  it('accepts a minimal valid gate', async () => {
    const { validateGate } = await importSchema()
    expect(validateGate(VALID_GATE).ok).toBe(true)
  })

  it('rejects a gate missing a required field', async () => {
    const { validateGate } = await importSchema()
    const { id, ...rest } = VALID_GATE
    expect(validateGate(rest).ok).toBe(false)
  })

  it('accepts a gate with a valid workflow-step prCoverage', async () => {
    const { validateGate } = await importSchema()
    const gate = {
      ...VALID_GATE,
      prCoverage: {
        kind: 'workflow-step',
        workflow: 'ci.yml',
        jobId: 'check',
        stepName: 'Typecheck',
      },
    }
    expect(validateGate(gate).ok).toBe(true)
  })

  it('rejects a gate with prCoverage missing required fields for its kind', async () => {
    const { validateGate } = await importSchema()
    const gate = { ...VALID_GATE, prCoverage: { kind: 'workflow-step', workflow: 'ci.yml' } }
    expect(validateGate(gate).ok).toBe(false)
  })

  it('accepts a gate with a valid exception prCoverage', async () => {
    const { validateGate } = await importSchema()
    const gate = { ...VALID_GATE, prCoverage: { kind: 'exception', reason: 'requires docker' } }
    expect(validateGate(gate).ok).toBe(true)
  })

  it('rejects an exception prCoverage with an empty reason', async () => {
    const { validateGate } = await importSchema()
    const gate = { ...VALID_GATE, prCoverage: { kind: 'exception', reason: '  ' } }
    expect(validateGate(gate).ok).toBe(false)
  })

  it('rejects prCoverage with an unknown kind', async () => {
    const { validateGate } = await importSchema()
    const gate = { ...VALID_GATE, prCoverage: { kind: 'bogus' } }
    expect(validateGate(gate).ok).toBe(false)
  })

  // requiredFor is consumed by publish-gate.mjs / pages-release.mjs via an
  // exact-string `.includes('publish')` check, so a typo'd tier is not a
  // structural error there — it just silently drops the gate from the tier
  // it was meant to guard. Validating against the closed vocabulary here is
  // what turns that into a loud validateMatrix failure instead.
  it('rejects a gate with a misspelled requiredFor tier', async () => {
    const { validateGate } = await importSchema()
    const gate = { ...VALID_GATE, requiredFor: ['publsih'] }
    expect(validateGate(gate).ok).toBe(false)
  })

  it('rejects a gate with an unknown category', async () => {
    const { validateGate } = await importSchema()
    const gate = { ...VALID_GATE, category: 'bogus-category' }
    expect(validateGate(gate).ok).toBe(false)
  })

  it('rejects a gate with an unknown expectedRuntimeBucket', async () => {
    const { validateGate } = await importSchema()
    const gate = { ...VALID_GATE, expectedRuntimeBucket: 'glacial' }
    expect(validateGate(gate).ok).toBe(false)
  })

  // No runner honors a per-gate `env` map (both publish-gate.mjs and
  // pages-release.mjs only read id/command/requiredFor), so the schema does
  // not validate it either — an unenforced validator on an unhonored field
  // would look load-bearing but silently do nothing. Additive unknown fields
  // are tolerated rather than rejected, matching the runners' own behavior
  // (see publish-gate-runner.test.ts "tolerate additive matrix fields").
  it('tolerates a gate carrying an arbitrary env field without validating its shape', async () => {
    const { validateGate, validateGateEnv } = await importSchema()
    const gate = { ...VALID_GATE, env: { WHITEBOARD_DEV: 1, nonsense: null } }
    expect(validateGate(gate).ok).toBe(true)
    expect(validateGateEnv).toBeUndefined()
  })
})

describe('validateMatrix', () => {
  it('accepts a minimal valid matrix', async () => {
    const { validateMatrix } = await importSchema()
    expect(validateMatrix({ schemaVersion: 1, gates: [VALID_GATE] }).ok).toBe(true)
  })

  it('rejects a matrix with the wrong schemaVersion', async () => {
    const { validateMatrix } = await importSchema()
    expect(validateMatrix({ schemaVersion: 2, gates: [VALID_GATE] }).ok).toBe(false)
  })

  it('rejects a matrix with an empty gates array', async () => {
    const { validateMatrix } = await importSchema()
    expect(validateMatrix({ schemaVersion: 1, gates: [] }).ok).toBe(false)
  })

  it('rejects a matrix with duplicate gate ids', async () => {
    const { validateMatrix } = await importSchema()
    expect(validateMatrix({ schemaVersion: 1, gates: [VALID_GATE, VALID_GATE] }).ok).toBe(false)
  })

  it('rejects a matrix containing an invalid gate', async () => {
    const { validateMatrix } = await importSchema()
    const badGate = { ...VALID_GATE, requiresDocker: true, requiredFor: ['ci'] }
    expect(validateMatrix({ schemaVersion: 1, gates: [badGate] }).ok).toBe(false)
  })
})
