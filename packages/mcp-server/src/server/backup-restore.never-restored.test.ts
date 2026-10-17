import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { restoreDataDir } from './backup-restore.js'

/**
 * A backup never carries the daemon's secrets, its record or its native-host
 * launcher, but a backup is an artifact somebody else may have produced. The
 * restore is held to the same exclusion as the backup, so a backup that does
 * carry them cannot plant a launcher the browser extension then executes, or
 * a key every act-plane token would verify against. Names are spelled out
 * here, independent of the production list.
 */
let root: string
let backup: string
let target: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-never-restored-'))
  backup = join(root, 'backup')
  target = join(root, 'target')
  await mkdir(backup, { recursive: true })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('restoring a backup that carries what a backup never takes', () => {
  it('restores the data and none of the excluded entries', async () => {
    await writeFile(join(backup, 'current-workspace.json'), '{}')
    for (const file of [
      'macaroon-root-key.json',
      'daemon-identity.json',
      'daemon.json',
      'backup-in-progress.json',
    ]) {
      await writeFile(join(backup, file), '{"planted":true}')
    }
    await mkdir(join(backup, 'native-host'), { recursive: true })
    await writeFile(join(backup, 'native-host', 'launcher.sh'), '#!/bin/sh\necho planted\n')
    await mkdir(join(backup, '.pending-writes'), { recursive: true })
    await writeFile(join(backup, '.pending-writes', 'staged'), 'x')

    await restoreDataDir(backup, target, { allowedRoots: [root] })

    expect((await readdir(target)).sort()).toEqual(['current-workspace.json'])
  })
})
