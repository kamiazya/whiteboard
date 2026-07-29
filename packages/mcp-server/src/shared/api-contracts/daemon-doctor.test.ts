import { describe, expect, it } from 'vitest'

import { daemonDoctorResultSchema } from './daemon-doctor.js'

describe('daemonDoctorResultSchema', () => {
  it('accepts a healthy result with no checks', () => {
    const input = { schemaVersion: 1, ok: true, status: 'ok', checks: [] }
    expect(daemonDoctorResultSchema.parse(input)).toEqual(input)
  })

  it('accepts a result with mixed check statuses', () => {
    const input = {
      schemaVersion: 1,
      ok: false,
      status: 'warning',
      checks: [
        { id: 'port', status: 'ok', summary: 'Port available' },
        {
          id: 'disk',
          status: 'warning',
          summary: 'Low disk',
          detail: '< 1GB',
          remediation: 'Free space',
        },
        { id: 'db', status: 'error', summary: 'DB unreachable' },
        { id: 'optional', status: 'skipped', summary: 'Skipped check' },
      ],
    }
    expect(daemonDoctorResultSchema.parse(input)).toEqual(input)
  })

  it('rejects wrong schemaVersion', () => {
    expect(() =>
      daemonDoctorResultSchema.parse({ schemaVersion: 2, ok: true, status: 'ok', checks: [] }),
    ).toThrow()
  })

  it('rejects missing ok field', () => {
    expect(() =>
      daemonDoctorResultSchema.parse({ schemaVersion: 1, status: 'ok', checks: [] }),
    ).toThrow()
  })

  it('rejects invalid check status', () => {
    expect(() =>
      daemonDoctorResultSchema.parse({
        schemaVersion: 1,
        ok: true,
        status: 'ok',
        checks: [{ id: 'x', status: 'critical', summary: 'bad' }],
      }),
    ).toThrow()
  })

  it('rejects check missing required id', () => {
    expect(() =>
      daemonDoctorResultSchema.parse({
        schemaVersion: 1,
        ok: true,
        status: 'ok',
        checks: [{ status: 'ok', summary: 'no id' }],
      }),
    ).toThrow()
  })
})
