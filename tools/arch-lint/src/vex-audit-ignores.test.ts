// An advisory this repository suppresses as not exploitable is suppressed in
// THREE places, and they must say the same thing:
//
//   - `pnpm-workspace.yaml`'s `auditConfig.ignoreGhsas`, which `pnpm audit:prod`
//     reads — the reason lives in a YAML comment no consumer can parse;
//   - the OpenVEX document, which is that reason published in the standard
//     machine-readable form (OSPS Baseline OSPS-VM-04.02), so a user's scanner
//     can apply the same judgement to the package they installed;
//   - the Dependency Review step's `allow-ghsas`, or a pull request that
//     touches the vulnerable package fails a check `pnpm audit` passes.
//
// One list drifting from another reads as a clean gate, so each pair is held
// from both sides.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { REPO_ROOT } from './scan-roots.js'

const VEX_PATH = '.github/security/whiteboard.openvex.json'

interface VexStatement {
  vulnerability?: { name?: string }
  products?: { '@id'?: string; subcomponents?: { '@id'?: string }[] }[]
  status?: string
  justification?: string
  impact_statement?: string
}
interface VexDocument {
  '@context'?: string
  author?: string
  timestamp?: string
  version?: number
  statements?: VexStatement[]
}

const ignored: string[] =
  (
    parseYaml(readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf-8')) as {
      auditConfig?: { ignoreGhsas?: string[] }
    }
  ).auditConfig?.ignoreGhsas ?? []

function readVex(): VexDocument {
  return JSON.parse(readFileSync(join(REPO_ROOT, VEX_PATH), 'utf-8')) as VexDocument
}

function dependencyReviewAllowList(): string[] {
  const workflow = parseYaml(
    readFileSync(join(REPO_ROOT, '.github/workflows/dependency-review.yml'), 'utf-8'),
  ) as { jobs?: Record<string, { steps?: { uses?: string; with?: Record<string, unknown> }[] }> }
  const step = Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .find((s) => (s.uses ?? '').startsWith('actions/dependency-review-action@'))
  return String(step?.with?.['allow-ghsas'] ?? '')
    .split(/[\s,]+/)
    .filter((id) => id !== '')
}

describe('advisories suppressed as not exploitable are published as VEX', () => {
  it('reads the audit suppression list', () => {
    expect(ignored.length).toBeGreaterThan(0)
  })

  it('is an OpenVEX document', () => {
    const vex = readVex()
    expect(vex['@context']).toMatch(/^https:\/\/openvex\.dev\/ns\/v0\.2\.\d+$/)
    expect(vex.author).toBeTruthy()
    expect(Number.isNaN(Date.parse(vex.timestamp ?? ''))).toBe(false)
    expect(vex.version).toBeGreaterThanOrEqual(1)
  })

  it('states exactly the advisories pnpm audit ignores', () => {
    const stated = (readVex().statements ?? []).map((s) => s.vulnerability?.name)
    expect([...stated].sort()).toEqual([...ignored].sort())
  })

  it('justifies every statement and names the component it is about', () => {
    for (const statement of readVex().statements ?? []) {
      const id = statement.vulnerability?.name
      expect(statement.status, id).toBe('not_affected')
      expect(statement.justification, id).toBeTruthy()
      expect((statement.impact_statement ?? '').length, id).toBeGreaterThan(40)
      const components = (statement.products ?? []).flatMap((p) => p.subcomponents ?? [])
      expect(
        components.some((c) => (c['@id'] ?? '').startsWith('pkg:npm/')),
        id,
      ).toBe(true)
    }
  })

  it('allows exactly the same advisories in the Dependency Review step', () => {
    expect([...dependencyReviewAllowList()].sort()).toEqual([...ignored].sort())
  })
})
