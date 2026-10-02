import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { warnWhenDataDirIsTempFallback } from './data-dir-fallback.js'
import { captureLogsForTests } from './log.js'

const TMP = resolve(tmpdir(), '.whiteboard')

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
