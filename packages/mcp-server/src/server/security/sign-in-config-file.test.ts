import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadSignInProviders } from './sign-in-config-file.js'

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

describe('loadSignInProviders', () => {
  it('reads a YAML file and resolves a secret from the environment', async () => {
    const path = join(dir, 'sign-in.yaml')
    await writeFile(path, yaml('{ env: GOOGLE_SECRET }'))
    const [google] = loadSignInProviders(path, { GOOGLE_SECRET: 'abc' })
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
    expect(loadSignInProviders(path, {})[0]?.clientSecretValue).toBe('from-file')
  })

  // A keeper that starts with a provider it cannot use would fail at the
  // first sign-in instead; refusing at startup names the problem once.
  it('refuses a secret whose environment variable is unset, naming it', async () => {
    const path = join(dir, 'sign-in.yaml')
    await writeFile(path, yaml('{ env: GOOGLE_SECRET }'))
    expect(() => loadSignInProviders(path, {})).toThrow(/GOOGLE_SECRET/)
  })

  it('refuses a file that does not match the schema', async () => {
    const path = join(dir, 'sign-in.yaml')
    await writeFile(path, yaml('hunter2'))
    expect(() => loadSignInProviders(path, {})).toThrow(/sign-in configuration/)
  })
})
