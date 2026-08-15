import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeDocumentIndexConformance } from '@kamiazya/whiteboard-canvas-ports/test-utils'
import { describe } from 'vitest'
import { createIsolatedDb } from './db/test-helpers.js'
import { SqliteDocumentIndex } from './sqlite-document-index.js'

describe('SqliteDocumentIndex', () => {
  describeDocumentIndexConformance(async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-document-index-'))
    const handle = await createIsolatedDb({ dataDir: tempDir })
    return {
      index: new SqliteDocumentIndex(handle.db),
      dispose: async () => {
        await handle.dispose()
        await rm(tempDir, { recursive: true, force: true })
      },
    }
  })
})
