import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDaemonRecordPath } from '../daemon-registry.js'
import { resolveDaemonEndpoint } from './daemon-endpoint.js'

describe('resolveDaemonEndpoint', () => {
  let dataDir: string | undefined
  afterEach(async () => {
    if (dataDir !== undefined) await rm(dataDir, { recursive: true, force: true })
    dataDir = undefined
  })

  it('answers null when no daemon record exists', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'wb-native-host-'))
    await expect(resolveDaemonEndpoint(dataDir)).resolves.toBeNull()
  })

  it("rejects with the record reader's refusal, naming the record", async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'wb-native-host-'))
    const target = join(dataDir, 'elsewhere.json')
    await writeFile(target, '{}')
    await symlink(target, getDaemonRecordPath(dataDir))
    await expect(resolveDaemonEndpoint(dataDir)).rejects.toThrow(getDaemonRecordPath(dataDir))
  })
})
