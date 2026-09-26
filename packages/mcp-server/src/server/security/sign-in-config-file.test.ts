import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { signsInWithBrowser } from './oidc-relying-party.js'
import { loadSignInConfig } from './sign-in-config-file.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-sign-in-config-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const yaml = (secret: string) => `providers:
  - id: google
    kind: oidc
    issuer: https://accounts.google.com
    clientId: client-1
    clientSecret: ${secret}
    admission:
      googleHostedDomains: [corp.example]
`

describe('loadSignInConfig', () => {
  it('reads a YAML file and resolves a secret from the environment', async () => {
    const path = join(dir, 'sign-in.yaml')
    await writeFile(path, yaml('{ env: GOOGLE_SECRET }'))
    const [google] = loadSignInConfig(path, { GOOGLE_SECRET: 'abc' }).providers
    expect(google?.clientSecretValue).toBe('abc')
    expect(google?.admission.googleHostedDomains).toEqual(['corp.example'])
  })

  it('reads a JSON file and resolves a secret from a file, trimmed', async () => {
    const secretPath = join(dir, 'secret')
    await writeFile(secretPath, 'from-file\n')
    const path = join(dir, 'sign-in.json')
    await writeFile(
      path,
      JSON.stringify({
        providers: [
          {
            id: 'corp',
            kind: 'oidc',
            issuer: 'https://sso.corp.example',
            clientId: 'wb',
            clientSecret: { file: secretPath },
          },
        ],
      }),
    )
    expect(loadSignInConfig(path, {}).providers[0]?.clientSecretValue).toBe('from-file')
  })

  // ADR-0049 decision 2: the keeper starts knowing who the file names as
  // administrators, as the bindings a request resolves to.
  it('reads the administrators the file names', async () => {
    const path = join(dir, 'sign-in.yaml')
    await writeFile(
      path,
      `${yaml('{ env: GOOGLE_SECRET }')}administrators:\n  - { provider: google, subject: ada-1 }\n`,
    )
    const { administrators } = loadSignInConfig(path, { GOOGLE_SECRET: 'abc' })
    expect(administrators).toHaveLength(1)
    expect(administrators[0]?.subject).toBe('ada-1')
    expect(administrators[0]?.authenticator.startsWith('oidc:')).toBe(true)
  })

  // A keeper that starts with a provider it cannot use would fail at the
  // first sign-in instead; refusing at startup names the problem once.
  it('refuses a secret whose environment variable is unset, naming it', async () => {
    const path = join(dir, 'sign-in.yaml')
    await writeFile(path, yaml('{ env: GOOGLE_SECRET }'))
    expect(() => loadSignInConfig(path, {})).toThrow(/GOOGLE_SECRET/)
  })

  // No client means no secret to resolve, and no browser sign-in.
  it('loads a bearer-only provider without a secret', async () => {
    const path = join(dir, 'sign-in.yaml')
    await writeFile(
      path,
      `providers:
  - id: corp-mcp
    kind: oidc
    issuer: https://sso.corp.example
    admission:
      createAccounts: true
      bearerClients: [claude-code]
`,
    )
    const [provider] = loadSignInConfig(path, {}).providers
    expect(provider?.id).toBe('corp-mcp')
    expect(provider !== undefined && signsInWithBrowser(provider)).toBe(false)
  })

  it('refuses a file that does not match the schema', async () => {
    const path = join(dir, 'sign-in.yaml')
    await writeFile(path, yaml('hunter2'))
    expect(() => loadSignInConfig(path, {})).toThrow(/sign-in configuration/)
  })
})
