import { describe, expect, it } from 'vitest'
import { fc, withDefaults } from '../../shared/test-utils/fast-check.js'
import { backupDirName, isBackupDirName } from './backup-dir-name.js'

describe('backup directory names', () => {
  it('matches every name the writer produces', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('1970-01-01T00:00:00.000Z'),
          max: new Date('9999-12-31T23:59:59.999Z'),
          noInvalidDate: true,
        }),
        (at) => {
          expect(isBackupDirName(backupDirName(at))).toBe(true)
        },
      ),
      withDefaults(),
    )
  })

  it('sorts in time order, which is what lets retention order by name', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('1970-01-01T00:00:00.000Z'),
          max: new Date('9999-12-31T23:59:59.999Z'),
          noInvalidDate: true,
        }),
        fc.date({
          min: new Date('1970-01-01T00:00:00.000Z'),
          max: new Date('9999-12-31T23:59:59.999Z'),
          noInvalidDate: true,
        }),
        (a, b) => {
          expect(backupDirName(a) < backupDirName(b)).toBe(a.getTime() < b.getTime())
        },
      ),
      withDefaults(),
    )
  })

  it('has no colon, so it is a filesystem-safe name on every platform', () => {
    expect(backupDirName(new Date('2026-03-04T05:06:07.089Z'))).toBe('2026-03-04T05-06-07.089Z')
  })

  it.each([
    'notes.txt',
    'README',
    '2026-03-04T05-06-07.089Z.incomplete',
    '2026-03-04T05:06:07.089Z',
    '2026-03-04',
    '',
  ])('does not read %j as a backup', (name) => {
    expect(isBackupDirName(name)).toBe(false)
  })
})
