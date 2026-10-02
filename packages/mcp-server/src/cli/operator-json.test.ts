// The operator commands' `--json` stdout is a scripting contract
// (docs/how-to/self-host-with-docker.md): one declaration per command, and a
// payload must survive being written and read back through it.
import { describe, expect, it } from 'vitest'
import {
  addUserOutputSchema,
  daemonSupportBundleOutputSchema,
  deactivateUserOutputSchema,
  grantAdminOutputSchema,
  grantMemberOutputSchema,
  nativeHostInstallOutputSchema,
  OPERATOR_JSON_SCHEMA_VERSION,
  searchFetchModelOutputSchema,
  serverRestoreOutputSchema,
  serverRunDryRunOutputSchema,
  serverRunReadyOutputSchema,
  serverSupportBundleOutputSchema,
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
  'server restore': {
    schema: serverRestoreOutputSchema,
    outputs: [{ ...v, ok: true, operation: 'restore' }],
  },
  'server run --dry-run': {
    schema: serverRunDryRunOutputSchema,
    outputs: [
      {
        ...v,
        ok: true,
        dryRun: true,
        publicBaseUrl: 'https://wb.example.com',
        allowedOrigins: ['https://wb.example.com', 'https://app.example.com'],
        authStrategy: 'oauth-jwt',
      },
    ],
  },
  'server run (ready)': {
    schema: serverRunReadyOutputSchema,
    outputs: [
      {
        ...v,
        ok: true,
        pid: 4242,
        host: '0.0.0.0',
        port: 3099,
        publicBaseUrl: 'https://wb.example.com',
        authStrategy: 'oauth-jwt',
        startedAt: '2026-05-21T00:00:00.000Z',
      },
    ],
  },
  'server support-bundle': {
    schema: serverSupportBundleOutputSchema,
    outputs: [
      {
        ...v,
        ok: true,
        operation: 'support-bundle',
        files: ['status.json', 'doctor.json', 'record.json', 'manifest.json'],
      },
    ],
  },
  'daemon support-bundle': {
    schema: daemonSupportBundleOutputSchema,
    outputs: [
      {
        ...v,
        ok: true,
        outputDir: '/tmp/bundle',
        files: ['status.json', 'doctor.json', 'logs.jsonl', 'manifest.json'],
      },
    ],
  },
  'search fetch-model': {
    schema: searchFetchModelOutputSchema,
    outputs: [
      {
        ...v,
        kind: 'ok',
        ok: true,
        cacheDir: '/data/models',
        model: 'Xenova/multilingual-e5-small',
        dtype: 'q8',
        dimensions: 384,
        elapsedMs: 1200,
      },
      {
        ...v,
        kind: 'failed',
        ok: false,
        cacheDir: '/data/models',
        model: 'Xenova/multilingual-e5-small',
        dtype: 'fp32',
        failure: 'runtime-missing',
        remedy: 'npm install @huggingface/transformers',
        detail: 'Cannot find package',
      },
    ],
  },
} as const

describe('operator --json output contracts', () => {
  it('declares a schema for every operator command, each with at least one arm', () => {
    expect(Object.keys(CONTRACTS)).toHaveLength(11)
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
