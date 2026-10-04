import { describe, expect, it } from 'vitest'
import { credentialGateCalls } from './auth-surface-scan.js'

// `credentialGateCalls` keys on what a file is HANDED: an import of a gate module or gate type, or a
// declaration of one. Each recognition arm is exercised alone here, because a file the scanner decides
// is "not handed a gate" reports nothing — the failure that hides a gating surface from the ledger.
const call = 'declare const x: any\nx.resolve(1)\n'

describe('credentialGateCalls: what hands a file a gate', () => {
  it('an import of a gate MODULE, whatever the path in front of it', () => {
    expect(
      credentialGateCalls(
        'a.ts',
        `import { thing } from '../security/credential-resolver.js'\n${call}`,
      ),
    ).toEqual(['resolve'])
    expect(credentialGateCalls('a.ts', `import { thing } from './mcp-auth.js'\n${call}`)).toEqual([
      'resolve',
    ])
    expect(
      credentialGateCalls('a.ts', `import { thing } from 'oauth-resource-strategy'\n${call}`),
    ).toEqual(['resolve'])
  })

  it('an import naming a gate TYPE among others, and under an alias', () => {
    expect(
      credentialGateCalls(
        'a.ts',
        `import { Unrelated, CredentialResolver } from './elsewhere.js'\n${call}`,
      ),
    ).toEqual(['resolve'])
    expect(
      credentialGateCalls(
        'a.ts',
        `import { AsyncAuthStrategy as Strategy, Other } from './elsewhere.js'\n${call}`,
      ),
    ).toEqual(['resolve'])
  })

  it('a file that DECLARES a gate type, as an interface or as an alias', () => {
    expect(
      credentialGateCalls('a.ts', `interface CredentialResolver { resolve(): void }\n${call}`),
    ).toEqual(['resolve'])
    expect(
      credentialGateCalls('a.ts', `type McpHttpAuthStrategy = { authorize(): void }\n${call}`),
    ).toEqual(['resolve'])
  })

  it('a file handed nothing reports nothing, whatever it calls', () => {
    expect(credentialGateCalls('a.ts', `import { resolve } from 'node:path'\n${call}`)).toEqual([])
    expect(credentialGateCalls('a.ts', `interface Unrelated {}\n${call}`)).toEqual([])
  })
})

describe('credentialGateCalls: what counts as a call', () => {
  const handed = "import type { CredentialResolver } from './credential-resolver.js'\n"

  it('a destructured gate method, bare or renamed, with an identifier or a quoted key', () => {
    expect(
      credentialGateCalls(
        'a.ts',
        `${handed}declare const r: any\nconst { resolve } = r\nresolve(1)\n`,
      ),
    ).toEqual(['resolve'])
    expect(
      credentialGateCalls(
        'a.ts',
        `${handed}declare const r: any\nconst { authorize: ask } = r\nask(1)\n`,
      ),
    ).toEqual(['ask'])
    expect(
      credentialGateCalls(
        'a.ts',
        `${handed}declare const r: any\nconst { 'resolve': ask } = r\nask(1)\n`,
      ),
    ).toEqual(['ask'])
  })

  it('a parameter named resolve, a Promise.resolve and a destructured non-gate are not asking a credential anything', () => {
    expect(
      credentialGateCalls(
        'a.ts',
        `${handed}new Promise((resolve) => resolve(1))\nPromise.resolve(2)\nconst { other } = {} as any\nother(3)\n`,
      ),
    ).toEqual([])
  })

  it('a bracketed method name is read like a dotted one', () => {
    expect(
      credentialGateCalls('a.ts', `${handed}declare const s: any\ns['authorize'](1)\n`),
    ).toEqual(['authorize'])
  })
})
