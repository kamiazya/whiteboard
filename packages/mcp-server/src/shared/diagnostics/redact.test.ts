import { describe, expect, it } from 'vitest'
import { fc, fcTest } from '../test-utils/fast-check.js'
import { redactDiagnosticText, redactDiagnosticValue } from './redact.js'

describe('redactDiagnosticText', () => {
  it('replaces a bearer token and an absolute path', () => {
    expect(redactDiagnosticText('GET /Users/me/project/x.ts with Bearer abc.def')).toBe(
      'GET [REDACTED_PATH] with Bearer [REDACTED]',
    )
  })

  it('replaces a drive-letter path, either separator', () => {
    expect(redactDiagnosticText('cannot read C:\\Users\\alice\\.whiteboard\\daemon.json')).toBe(
      'cannot read [REDACTED_PATH]',
    )
    expect(redactDiagnosticText('cannot read d:/Users/alice/daemon.json')).toBe(
      'cannot read [REDACTED_PATH]',
    )
  })

  it('replaces a UNC path and a device path such as a named pipe', () => {
    expect(redactDiagnosticText('share \\\\server\\share\\x is offline')).toBe(
      'share [REDACTED_PATH] is offline',
    )
    expect(redactDiagnosticText('pipe \\\\.\\pipe\\whiteboard-alice refused')).toBe(
      'pipe [REDACTED_PATH] refused',
    )
  })

  // A path's segments are what name the person and the host; none survives,
  // whatever the root and separator, and the prose around the path does.
  const segment = fc.stringMatching(/^[A-Za-z0-9_.-]{1,12}$/)
  const windowsPath = fc.oneof(
    fc
      .tuple(fc.constantFrom('C:', 'z:'), fc.constantFrom('\\', '/'))
      .map(([drive, sep]) => ({ root: drive + sep, sep })),
    fc.constantFrom('\\\\', '\\\\.\\', '\\\\?\\C:\\').map((root) => ({ root, sep: '\\' })),
  )
  fcTest.prop([windowsPath, fc.array(segment, { minLength: 1, maxLength: 5 }), segment])(
    'leaves no segment of a Windows path in the text',
    ({ root, sep }, segments, secret) => {
      const path = root + [...segments, `${secret}SECRET`].join(sep)
      expect(redactDiagnosticText(`failed at ${path} today`)).toBe(
        'failed at [REDACTED_PATH] today',
      )
    },
  )

  it('has no way to keep a path: a stray second argument changes nothing', () => {
    // @ts-expect-error the redactor takes no options
    expect(redactDiagnosticText('/opt/wb/server.ts', { keepPaths: true })).toBe('[REDACTED_PATH]')
  })
})

describe('redactDiagnosticValue', () => {
  it('redacts strings at every depth and leaves other values alone', () => {
    expect(redactDiagnosticValue({ a: ['/etc/passwd', 3, null], b: { c: 'Bearer t0k' } })).toEqual({
      a: ['[REDACTED_PATH]', 3, null],
      b: { c: 'Bearer [REDACTED]' },
    })
  })

  it('names what it cannot serialise rather than passing it through', () => {
    expect(redactDiagnosticValue(10n)).toBe('[REDACTED_NON_SERIALIZABLE]')
  })
})
