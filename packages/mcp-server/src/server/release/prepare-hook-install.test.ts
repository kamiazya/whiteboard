// `prepare` must stay non-fatal — it runs on every `pnpm install`, including
// in environments with no git dir and for consumers installing the published
// package, where a hard failure would break the install outright. But a
// swallowed failure leaves a developer with NO pre-commit or pre-push gate
// and nothing on screen saying so, and the gates are the only thing standing
// between a broken commit and CI. Non-fatal AND loud is the requirement.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../../../..')

function prepareScript(): string {
  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
    scripts?: Record<string, string>
  }
  const script = packageJson.scripts?.prepare
  expect(script, 'root package.json must declare a prepare script').toBeDefined()
  return script as string
}

describe('root package.json prepare', () => {
  it('installs the git hooks', () => {
    expect(prepareScript()).toContain('lefthook install')
  })

  it('does not fail the install when hook installation fails', () => {
    expect(prepareScript()).toMatch(/\|\|/)
  })

  it('says something when hook installation fails, instead of swallowing it', () => {
    const fallback = prepareScript().split('||').slice(1).join('||').trim()
    expect(
      fallback,
      'the `||` fallback must report the failure, not discard it with `true`',
    ).not.toMatch(/^true\b/)
    expect(fallback.toLowerCase()).toMatch(/echo|warn/)
  })
})
