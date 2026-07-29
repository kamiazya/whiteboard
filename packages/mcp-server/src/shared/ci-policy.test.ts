import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../')

// A full 40-character hex commit SHA — the only form that is immutable.
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/

describe('release.yml — action pinning policy', () => {
  it('every uses: entry is pinned to a 40-char commit SHA (no mutable tags)', async () => {
    const text = await readFile(join(REPO_ROOT, '.github/workflows/release.yml'), 'utf-8')

    // Extract all `uses: owner/repo@ref` values. Local composite actions
    // (relative paths starting with "./") are excluded: they are not external
    // supply-chain dependencies — the checked-out commit itself already pins
    // their contents, so there is no separate ref to SHA-pin.
    const usesRefs = [...text.matchAll(/uses:\s+(\S+)/g)]
      .map((m) => m[1])
      .filter((ref) => !ref.startsWith('./'))
    expect(usesRefs.length).toBeGreaterThan(0)

    for (const ref of usesRefs) {
      const at = ref.lastIndexOf('@')
      expect(at, `${ref}: missing @ separator`).toBeGreaterThan(0)
      const sha = ref.slice(at + 1)
      expect(
        COMMIT_SHA_RE.test(sha),
        `Action ${ref} uses mutable ref "${sha}" — pin to a 40-char commit SHA`,
      ).toBe(true)
    }
  })
})

describe('setup-pnpm composite action — pinning policy', () => {
  it('every uses: entry is pinned to a 40-char commit SHA (no mutable tags)', async () => {
    const text = await readFile(join(REPO_ROOT, '.github/actions/setup-pnpm/action.yml'), 'utf-8')

    const usesRefs = [...text.matchAll(/uses:\s+(\S+)/g)].map((m) => m[1])
    expect(usesRefs.length).toBeGreaterThan(0)

    for (const ref of usesRefs) {
      const at = ref.lastIndexOf('@')
      expect(at, `${ref}: missing @ separator`).toBeGreaterThan(0)
      const sha = ref.slice(at + 1)
      expect(
        COMMIT_SHA_RE.test(sha),
        `Action ${ref} uses mutable ref "${sha}" — pin to a 40-char commit SHA`,
      ).toBe(true)
    }
  })
})

describe('release.yml — root permissions policy', () => {
  it('packages: write is absent from the workflow root permissions block', async () => {
    const text = await readFile(join(REPO_ROOT, '.github/workflows/release.yml'), 'utf-8')

    // Everything before `jobs:` is the workflow preamble (root-level keys).
    // `packages: write` with 2-space indent is a root-level permissions entry.
    const preamble = text.split(/^jobs:/m)[0] ?? text
    expect(
      preamble,
      'packages: write found at workflow root — it must be scoped to docker-publish-sign job only',
    ).not.toMatch(/^ {2}packages:\s+write/m)
  })
})

describe('ci.yml — server noConsole lint gate', () => {
  it('runs the server noConsole gate in the verify job', async () => {
    const text = await readFile(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf-8')
    expect(
      text,
      'ci.yml must run pnpm lint:noconsole so AGENTS.md server-console discipline is enforced in CI',
    ).toMatch(/run:\s+pnpm lint:noconsole/)
  })

  it('the lint:noconsole script targets the server tree with the noConsole rule', async () => {
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>
    }
    const script = pkg.scripts?.['lint:noconsole'] ?? ''
    expect(script, 'lint:noconsole script must exist').not.toBe('')
    expect(script).toContain('lint/suspicious/noConsole')
    expect(script).toContain('packages/mcp-server/src/server')
  })
})
