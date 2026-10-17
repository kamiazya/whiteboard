import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { warnWhenDataDirIsTempFallback } from './data-dir-fallback.js'
import { captureLogsForTests } from './log.js'

// The temp fallback is per user: a fixed name in the shared temp dir is one
// another user can create first. Spelled out here rather than imported, so
// the expectation is not the code under test.
const TMP_FALLBACK_NAME = process.getuid ? `.whiteboard-${process.getuid()}` : '.whiteboard'

const TMP = resolve(tmpdir(), TMP_FALLBACK_NAME)

function warningsFor(dataDir: string, env: NodeJS.ProcessEnv) {
  const capture = captureLogsForTests('warning')
  try {
    warnWhenDataDirIsTempFallback(dataDir, env)
    return capture.records.filter((record) => record.level === 'warning')
  } finally {
    capture.restore()
  }
}

describe('warnWhenDataDirIsTempFallback', () => {
  it('names the temp path when no data dir was chosen and the home dir was unusable', () => {
    const [warning, ...rest] = warningsFor(TMP, {})
    expect(rest).toEqual([])
    expect(warning?.data?.dataDir).toBe(TMP)
    expect(warning?.msg).toMatch(/temp/i)
  })

  it('stays quiet when the operator chose a data dir, even one under the temp dir', () => {
    expect(warningsFor(TMP, { WHITEBOARD_DATA_DIR: TMP })).toEqual([])
  })

  it('stays quiet for the ordinary home data dir', () => {
    expect(warningsFor(resolve('/home/someone/.whiteboard'), {})).toEqual([])
  })
})
