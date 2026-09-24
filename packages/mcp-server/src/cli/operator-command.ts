// What the operator commands that write a keeper's people (`grant-member`,
// `add-user`) share: where they write their answer, and the database they
// open. stdout is always the outcome as one JSON line; stderr is the words.
import { resolve } from 'node:path'
import { resolveDefaultDataDir } from '../daemon/data-dir.js'
import { getDb } from '../server/store/db/index.js'
import { prepareDataDir } from '../server/store/db/prepare.js'
import type { TenantDatabase } from '../server/store/db/tenant-database.js'

export interface Io {
  stdout(text: string): void
  stderr(text: string): void
}

export const processIo: Io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}

export function usageError(io: Io, message: string): number {
  io.stderr(`${message}\n`)
  return 64
}

export async function openKeeperDb(
  dataDir: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<TenantDatabase> {
  const dir = resolve(dataDir ?? resolveDefaultDataDir(env))
  await prepareDataDir(dir)
  return getDb(dir)
}
