import { describe, expect, it } from 'vitest'
import {
  buildSupportBundle,
  SUPPORT_BUNDLE_SCHEMA_VERSION,
  SupportBundleError,
  type SupportBundleInput,
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
}

function bundleAsConcatenatedText(bundle: ReturnType<typeof buildSupportBundle>): string {
  // Concatenated view of every file in the bundle. Used as the leak
  // probe: a leak in any section is a leak in the bundle as a whole.
  return Object.values(bundle.files).join('')
}

describe('support bundle v0', () => {
  it('produces a deterministic manifest + status + doctor section set with stable filenames', () => {
    const bundle = buildSupportBundle(minimalInput)
    expect(Object.keys(bundle.files).sort()).toEqual([
      'doctor.json',
      'manifest.json',
      'status.json',
    ])
    expect(bundle.manifest.schemaVersion).toBe(SUPPORT_BUNDLE_SCHEMA_VERSION)
    expect(bundle.manifest.sections).toEqual(['status.json', 'doctor.json'])
    expect(bundle.manifest.platform).toEqual({ os: 'darwin', nodeVersion: 'v22.0.0' })

    // Each JSON file must independently parse and end with a newline.
    for (const name of ['manifest.json', 'status.json', 'doctor.json'] as const) {
      const text = bundle.files[name]
      expect(text.endsWith('\n')).toBe(true)
      expect(() => JSON.parse(text.trim())).not.toThrow()
    }
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

  it('schema sanity: schemaVersion is literal 1; bumping breaks the contract', () => {
    const bundle = buildSupportBundle(minimalInput)
    supportBundleManifestSchema.parse(bundle.manifest)
    expect(() =>
      supportBundleManifestSchema.parse({ ...bundle.manifest, schemaVersion: 2 }),
    ).toThrow()
  })

  it('names the bundle it describes, and holds each mode to its own sections', () => {
    const { manifest } = buildSupportBundle(minimalInput)
    expect(manifest.mode).toBe('daemon')
    const server = { ...manifest, mode: 'server-mode', sections: ['status.json', 'record.json'] }
    expect(supportBundleManifestSchema.parse(server).mode).toBe('server-mode')
    expect(() =>
      supportBundleManifestSchema.parse({ ...server, sections: ['status.json', 'logs.jsonl'] }),
    ).toThrow()
    expect(() =>
      supportBundleManifestSchema.parse({ ...manifest, sections: ['record.json'] }),
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
    expect(() => buildSupportBundle({ ...minimalInput, createdAt: '2026-05-10T00:00:00' })).toThrow(
      SupportBundleError,
    )
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
    for (const name of ['manifest.json', 'status.json', 'doctor.json'] as const) {
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
