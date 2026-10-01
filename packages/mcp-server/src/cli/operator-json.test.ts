// The operator commands' `--json` stdout is a scripting contract
// (docs/how-to/self-host-with-docker.md): one declaration per command, and a
// payload must survive being written and read back through it.
import { describe, expect, it } from 'vitest'
import {
  addUserOutputSchema,
  deactivateUserOutputSchema,
  grantAdminOutputSchema,
  grantMemberOutputSchema,
  nativeHostInstallOutputSchema,
  OPERATOR_JSON_SCHEMA_VERSION,
} from './operator-json.js'

const ada = { id: '01JZ0000000000000000000001', displayName: 'Ada' }
const bob = { id: '01JZ0000000000000000000002', displayName: 'Bob' }
const v = { schemaVersion: OPERATOR_JSON_SCHEMA_VERSION }

const CONTRACTS = {
  'add-user': {
    schema: addUserOutputSchema,
    outputs: [
      { ...v, kind: 'ok', created: true, user: ada },
      { ...v, kind: 'unknown-provider', providers: ['corp-mcp', 'google'] },
    ],
  },
  'grant-admin': {
    schema: grantAdminOutputSchema,
    outputs: [
      { ...v, kind: 'ok', user: ada, administrator: true },
      { ...v, kind: 'unknown-user', users: [ada, bob] },
      { ...v, kind: 'ambiguous-user', users: [ada, ada] },
    ],
  },
  'grant-member': {
    schema: grantMemberOutputSchema,
    outputs: [
      { ...v, kind: 'ok', workspaceId: '01JZ0000000000000000000003', user: ada },
      { ...v, kind: 'unknown-workspace', workspaceId: 'ws-nowhere' },
      { ...v, kind: 'unknown-user', users: [] },
      { ...v, kind: 'ambiguous-user', users: [ada, bob] },
    ],
  },
  'deactivate-user': {
    schema: deactivateUserOutputSchema,
    outputs: [
      { ...v, kind: 'ok', user: ada, deactivated: true, changed: false },
      { ...v, kind: 'unknown-user', users: [bob] },
      { ...v, kind: 'ambiguous-user', users: [ada, bob] },
    ],
  },
  'native-host install': {
    schema: nativeHostInstallOutputSchema,
    outputs: [
      {
        ...v,
        ok: true,
        launcher: '/data/native-host/whiteboard-native-host',
        manifests: [
          { browser: 'chrome', engine: 'chromium', dir: '/home/u/.config/google-chrome' },
          {
            browser: 'edge',
            engine: 'chromium',
            dir: 'C:\\hosts',
            registryKey: 'HKCU\\Software\\Microsoft\\Edge',
          },
        ],
      },
      {
        ...v,
        ok: false,
        reason: 'no Chromium browser or Firefox was found',
        launcher: '/data/native-host/whiteboard-native-host',
        manifests: [],
      },
    ],
  },
} as const

describe('operator --json output contracts', () => {
  it('declares a schema for every operator command, each with at least one arm', () => {
    expect(Object.keys(CONTRACTS)).toHaveLength(5)
    for (const { outputs } of Object.values(CONTRACTS)) expect(outputs.length).toBeGreaterThan(0)
  })

  for (const [command, { schema, outputs }] of Object.entries(CONTRACTS)) {
    describe(command, () => {
      it.each(
        outputs.map((output) => [JSON.stringify(output)]),
      )('round-trips through its schema: %s', (line) => {
        const written = JSON.parse(line as string)
        expect(JSON.parse(JSON.stringify(schema.parse(written)))).toEqual(written)
      })

      it('refuses an output with no schemaVersion, a different one, or a stray key', () => {
        const [sample] = outputs
        const { schemaVersion: _omitted, ...unversioned } = sample as Record<string, unknown>
        expect(schema.safeParse(unversioned).success).toBe(false)
        expect(schema.safeParse({ ...sample, schemaVersion: 2 }).success).toBe(false)
        expect(schema.safeParse({ ...sample, extra: true }).success).toBe(false)
      })
    })
  }
})
