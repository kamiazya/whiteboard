import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../..')

describe('pre-merge CI workflow', () => {
  const workflowPath = resolve(repoRoot, '.github/workflows/ci.yml')

  it('provides a CI workflow for pull requests and main pushes', () => {
    expect(existsSync(workflowPath)).toBe(true)

    const workflow = readFileSync(workflowPath, 'utf-8')

    expect(workflow).toContain('name: ci')
    expect(workflow).toContain('pull_request:')
    expect(workflow).toContain('push:')
    expect(workflow).toContain('branches: [main]')
  })

  it('runs the publish-relevant quality gates before merge', () => {
    const workflow = readFileSync(workflowPath, 'utf-8')

    // PR title is passed via env var to avoid shell injection from user-controlled input.
    expect(workflow).toContain('PR_TITLE: ${{ github.event.pull_request.title }}')
    expect(workflow).toContain('pnpm check:pr-title -- "$PR_TITLE"')
    expect(workflow).toContain('pnpm install --frozen-lockfile')
    // Chromium is prebaked in the official Playwright image; no install step needed.
    expect(workflow).toContain('mcr.microsoft.com/playwright')
    expect(workflow).toContain('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD')
    expect(workflow).toContain('pnpm intent:validate')
    expect(workflow).toContain('pnpm typecheck')
    // Tests run as parallel sharded jobs via vitest project filters.
    expect(workflow).toContain('pnpm exec vitest run')
    expect(workflow).toContain('pnpm smoke:e2e')
    expect(workflow).toContain('pnpm build')
    expect(workflow).toContain('pnpm smoke:packaged')
    expect(workflow).toContain('pnpm smoke:tarball')
    expect(workflow).toContain('pnpm smoke:codex-config')
    expect(workflow).toContain('pnpm smoke:template')
  })
})
