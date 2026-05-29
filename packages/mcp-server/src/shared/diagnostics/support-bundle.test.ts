import { describe, expect, it } from 'vitest'
import {
  SUPPORT_BUNDLE_SCHEMA_VERSION,
  SupportBundleError,
  type SupportBundleInput,
  buildSupportBundle,
  supportBundleManifestSchema,
} from './support-bundle.js'

const FIXED_TS = '2026-05-10T00:00:00.000Z'

const minimalInput: SupportBundleInput = {
  createdAt: FIXED_TS,
  packageVersion: '0.0.4',
  platform: { os: 'darwin', nodeVersion: 'v22.0.0' },
  status: {
    ok: true,
    reason: null,
    recordFound: true,
    recordFresh: true,
    pidAlive: true,
    pingOk: true,
    statusOk: true,
    record: { pid: 1234, port: 3099, version: '0.0.4', startedAt: FIXED_TS },
  },
  doctor: {
    ok: true,
    status: 'ok',
    checks: [
      { id: 'daemon.record', status: 'ok', summary: 'Daemon record present.' },
      { id: 'daemon.token', status: 'ok', summary: 'Token present.' },
    ],
  },
  logs: [
    {
      timestamp: FIXED_TS,
      level: 'info',
      source: 'daemon',
      message: 'startup',
      fields: { pid: 1234, port: 3099, status: 'ok' },
    },
  ],
}

function bundleAsConcatenatedText(bundle: ReturnType<typeof buildSupportBundle>): string {
  // Concatenated view of every file in the bundle. Used as the leak
  // probe: a leak in any section is a leak in the bundle as a whole.
  return Object.values(bundle.files).join('')
}

describe('support bundle v0', () => {
  it('produces a deterministic manifest + status + doctor + logs section set with stable filenames', () => {
    // Use 2 log entries so the JSONL whole-stream JSON.parse guard
    // is meaningful — a single line happens to also parse as a JSON
    // object, which would mask an array-wrapper regression.
    const bundle = buildSupportBundle({
      ...minimalInput,
      logs: [
        ...minimalInput.logs,
        {
          timestamp: FIXED_TS,
          level: 'warn',
          source: 'daemon',
          message: 'tick 2',
          fields: { pid: 1234, status: 'ok' },
        },
      ],
    })
    expect(Object.keys(bundle.files).sort()).toEqual(
      ['doctor.json', 'logs.jsonl', 'manifest.json', 'status.json'],
    )
    expect(bundle.manifest.schemaVersion).toBe(SUPPORT_BUNDLE_SCHEMA_VERSION)
    expect(bundle.manifest.sections).toEqual(['status.json', 'doctor.json', 'logs.jsonl'])
    expect(bundle.manifest.platform).toEqual({ os: 'darwin', nodeVersion: 'v22.0.0' })

    // Each JSON file must independently parse and end with a newline.
    for (const name of ['manifest.json', 'status.json', 'doctor.json'] as const) {
      const text = bundle.files[name]
      expect(text.endsWith('\n')).toBe(true)
      expect(() => JSON.parse(text.trim())).not.toThrow()
    }
    // logs.jsonl is JSONL: each line independently parses, whole
    // stream MUST NOT be a single JSON document.
    const jsonl = bundle.files['logs.jsonl']
    expect(jsonl.endsWith('\n')).toBe(true)
    expect(() => JSON.parse(jsonl)).toThrow()
    const parsed = jsonl
      .slice(0, -1)
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(parsed).toHaveLength(2)
  })

  it('redacts tokens, Authorization markers, paths, and stack frames from every section', () => {
    const bundle = buildSupportBundle({
      ...minimalInput,
      status: {
        ...minimalInput.status,
        // Producer accidentally dumps the daemon record's whole
        // string-representation into `reason`. The redactor scrubs
        // tokens / paths / stack frames before they reach manifest.
        reason: 'Authorization: Bearer secret-token-XYZ at /opt/wb/server.ts:42',
      },
      doctor: {
        ok: false,
        status: 'error',
        checks: [
          {
            id: 'daemon.record',
            status: 'error',
            summary: 'Failed at /Users/me/whiteboard/data.db',
            detail: 'Authorization: Bearer secret-token-XYZ',
            remediation: 'Rerun from /tmp/wb/run.sh',
          },
        ],
      },
      logs: [
        {
          timestamp: FIXED_TS,
          level: 'error',
          source: 'daemon',
          message: 'Authorization: Bearer secret-token-XYZ at /opt/wb/server.ts:42',
          fields: { status: 'process-not-running' },
        },
      ],
    })

    const text = bundleAsConcatenatedText(bundle)
    expect(text).not.toContain('secret-token-XYZ')
    expect(text).not.toMatch(/Bearer/i)
    expect(text).not.toMatch(/Authorization/i)
    expect(text).not.toMatch(/\/opt\//)
    expect(text).not.toMatch(/\/Users\//)
    expect(text).not.toMatch(/\/tmp\//)
    expect(text).not.toMatch(/\.ts:\d/)
  })

  it('drops canvas-plaintext / migration / raw-MCP / token producer fields via the JSONL formatter allow-list', () => {
    const bundle = buildSupportBundle({
      ...minimalInput,
      logs: [
        {
          timestamp: FIXED_TS,
          level: 'info',
          source: 'mcp',
          message: 'tick',
          fields: {
            canvasText: 'TOP_SECRET_CANVAS_TEXT',
            elementText: 'TOP_SECRET_CANVAS_TEXT',
            scene: { elements: [{ text: 'TOP_SECRET_CANVAS_TEXT' }] },
            elements: [{ text: 'TOP_SECRET_CANVAS_TEXT' }],
            files: { 'fid-1': 'TOP_SECRET_CANVAS_TEXT' },
            rawPayload: 'TOP_SECRET_CANVAS_TEXT',
            requestHeaders: { authorization: 'Bearer secret-token-XYZ' },
            authorization: 'Bearer secret-token-XYZ',
            token: 'secret-token-XYZ',
            migrationBundle: { secret: 'TOP_SECRET_CANVAS_TEXT' },
            // Allow-listed survivors:
            pid: 7,
            port: 3099,
            status: 'ok',
          },
        },
      ],
    })
    const text = bundleAsConcatenatedText(bundle)
    expect(text).not.toContain('TOP_SECRET_CANVAS_TEXT')
    expect(text).not.toContain('secret-token-XYZ')
    expect(text).not.toContain('migrationBundle')
    expect(text).not.toContain('canvasText')
    expect(text).not.toContain('rawPayload')
    expect(text).not.toContain('requestHeaders')

    // Allow-listed fields stay.
    const parsed = JSON.parse(
      bundle.files['logs.jsonl'].slice(0, -1).split('\n')[0]!,
    ) as { fields: Record<string, unknown> }
    expect(parsed.fields).toEqual({ pid: 7, port: 3099, status: 'ok' })
  })

  it('schema sanity: schemaVersion is literal 1; bumping breaks the contract', () => {
    const bundle = buildSupportBundle(minimalInput)
    supportBundleManifestSchema.parse(bundle.manifest)
    expect(() =>
      supportBundleManifestSchema.parse({ ...bundle.manifest, schemaVersion: 2 }),
    ).toThrow()
  })

  it('fail-closed on invalid timestamp: throws SupportBundleError with a generic message that does not echo input', () => {
    let caught: unknown
    try {
      buildSupportBundle({ ...minimalInput, createdAt: 'not-a-date' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SupportBundleError)
    expect((caught as Error).message).not.toContain('not-a-date')
    expect((caught as Error).message).toMatch(/invalid support bundle manifest/i)
  })

  it('fail-closed on offset-less ISO timestamp', () => {
    expect(() =>
      buildSupportBundle({ ...minimalInput, createdAt: '2026-05-10T00:00:00' }),
    ).toThrow(SupportBundleError)
  })

  it('fail-closed when record.startedAt is a leaky non-ISO string — stops Authorization / paths / stack frames smuggling into status.json', () => {
    let caught: unknown
    try {
      buildSupportBundle({
        ...minimalInput,
        status: {
          ...minimalInput.status,
          record: {
            pid: 1234,
            port: 3099,
            version: '0.0.4',
            startedAt: 'Authorization: Bearer secret-token-XYZ at /opt/wb.ts:42',
          },
        },
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SupportBundleError)
    const msg = (caught as Error).message
    // Generic copy only — never echoes the leaky input value.
    expect(msg).not.toContain('secret-token-XYZ')
    expect(msg).not.toMatch(/Bearer/i)
    expect(msg).not.toMatch(/Authorization/i)
    expect(msg).not.toMatch(/\/opt\//)
    expect(msg).not.toMatch(/\.ts:\d/)
    expect(msg).toMatch(/record\.startedAt/i)
  })

  it('fail-closed when record.startedAt is offset-less ISO', () => {
    expect(() =>
      buildSupportBundle({
        ...minimalInput,
        status: {
          ...minimalInput.status,
          record: {
            pid: 1234,
            port: 3099,
            version: '0.0.4',
            startedAt: '2026-05-10T00:00:00',
          },
        },
      }),
    ).toThrow(SupportBundleError)
  })

  it('produces deterministic byte-for-byte output for the same input (replay friendly)', () => {
    const a = buildSupportBundle(minimalInput)
    const b = buildSupportBundle(minimalInput)
    for (const name of ['manifest.json', 'status.json', 'doctor.json', 'logs.jsonl'] as const) {
      expect(b.files[name]).toBe(a.files[name])
    }
  })

  it('manifest.sections is exactly the file map keys minus the manifest itself', () => {
    const bundle = buildSupportBundle(minimalInput)
    const filesWithoutManifest = Object.keys(bundle.files)
      .filter((k) => k !== 'manifest.json')
      .sort()
    expect([...bundle.manifest.sections].sort()).toEqual(filesWithoutManifest)
  })
})
