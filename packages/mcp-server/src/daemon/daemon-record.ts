import { readFile } from 'node:fs/promises'
import { getDaemonRecordPath, isPidAlive } from './daemon-registry.js'

export { isPidAlive }

export type DaemonRecordParseResult =
  | { kind: 'missing' }
  | { kind: 'malformed'; message: string }
  | { kind: 'token-missing'; record: { pid: number; port: number; version: string; startedAt: string } }
  | { kind: 'valid'; record: { pid: number; port: number; token: string; version: string; startedAt: string } }

export async function parseDaemonRecord(dataDir: string): Promise<DaemonRecordParseResult> {
  const recordPath = getDaemonRecordPath(dataDir)
  let raw: string
  try {
    raw = await readFile(recordPath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'missing' }
    }
    return { kind: 'malformed', message: 'Could not read daemon record file.' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'malformed', message: 'Daemon record is not valid JSON.' }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'malformed', message: 'Daemon record is not an object.' }
  }

  const obj = parsed as Record<string, unknown>
  if (
    typeof obj.pid !== 'number' ||
    typeof obj.port !== 'number' ||
    typeof obj.version !== 'string' ||
    typeof obj.startedAt !== 'string'
  ) {
    return { kind: 'malformed', message: 'Daemon record is missing required fields.' }
  }

  const base = {
    pid: obj.pid,
    port: obj.port,
    version: obj.version,
    startedAt: obj.startedAt,
  }

  if (typeof obj.token !== 'string' || obj.token === '') {
    return { kind: 'token-missing', record: base }
  }

  return { kind: 'valid', record: { ...base, token: obj.token } }
}
