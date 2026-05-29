import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { runTemplateSmokeChecks } from './template.smoke-impl.js'

describe('template smoke', () => {
  let dataDir: string
  let prevDataDir: string | undefined

  beforeAll(() => {
    prevDataDir = process.env.WHITEBOARD_DATA_DIR
    dataDir = mkdtempSync(join(tmpdir(), 'tpl-smoke-'))
    process.env.WHITEBOARD_DATA_DIR = dataDir
  })

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true })
    if (prevDataDir !== undefined) {
      process.env.WHITEBOARD_DATA_DIR = prevDataDir
    } else {
      delete process.env.WHITEBOARD_DATA_DIR
    }
  })

  it('all template tool checks pass', async () => {
    await runTemplateSmokeChecks()
  })
})
