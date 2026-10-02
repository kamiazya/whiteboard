import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { repoRoot } from '../shared/test-utils/repo-root.js'
import { signInConfigSchema } from './security/sign-in-config.js'

// The page an operator copies a sign-in file from. `<team>` and the like are
// where the operator's own value goes, so each is filled in before parsing:
// what is checked is the SHAPE the page teaches, and a copy that still holds
// its placeholder is refused by name in sign-in-config.test.ts.
const GUIDE = readFileSync(join(repoRoot(), 'docs/how-to/self-host-with-docker.md'), 'utf8')

/** Every yaml fence, dedented by the indentation of its opening line (list-item fences are indented). */
function yamlFences(markdown: string): unknown[] {
  return [...markdown.matchAll(/^([ \t]*)```ya?ml\n([\s\S]*?)^\1```/gm)].map(([, indent, body]) => {
    const dedented = (body ?? '')
      .split('\n')
      .map((line) => line.slice((indent ?? '').length))
      .join('\n')
    return parseYaml(dedented.replace(/<[^<>\n]+>/g, 'placeholder'))
  })
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// A fence is sign-in configuration when its top-level keys are the config's.
const SIGN_IN_KEYS = new Set(['providers', 'administrators'])
const configFences = yamlFences(GUIDE).filter(
  (fence): fence is Record<string, unknown> =>
    isRecord(fence) && Object.keys(fence).every((key) => SIGN_IN_KEYS.has(key)),
)
const withProviders = configFences.filter((fence) => 'providers' in fence)
const fragments = configFences.filter((fence) => !('providers' in fence))

describe('self-host-with-docker.md sign-in configuration examples', () => {
  // A fence regex that stops matching leaves every assertion below with
  // nothing to parse.
  it('finds the provider examples and the administrators fragment', () => {
    expect(withProviders.length).toBeGreaterThanOrEqual(4)
    expect(fragments.length).toBeGreaterThanOrEqual(1)
  })

  it('parses every provider example through the sign-in config schema', () => {
    for (const fence of withProviders) {
      const result = signInConfigSchema.safeParse(fence)
      expect(result.error?.issues, JSON.stringify(fence)).toBeUndefined()
    }
  })

  // The fragment names a provider and leaves declaring it to the examples
  // above it, so it is read together with every provider the page declares:
  // an administrator naming a provider the page never shows fails.
  it('parses the administrators fragment against the providers the page declares', () => {
    const providers = withProviders.flatMap((fence) => fence.providers as unknown[])
    for (const fragment of fragments) {
      const result = signInConfigSchema.safeParse({ ...fragment, providers })
      expect(result.error?.issues, JSON.stringify(fragment)).toBeUndefined()
    }
  })
})
