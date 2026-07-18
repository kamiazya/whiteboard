import { readFile } from 'node:fs/promises'
import {
  type DaemonRecord,
  type DaemonRecordBase,
  daemonRecordBaseSchema,
  daemonRecordSchema,
} from './daemon-record-schema.js'
import { getDaemonRecordPath, isPidAlive } from './daemon-registry.js'

export { isPidAlive }

export type DaemonRecordParseResult =
  | { kind: 'missing' }
  | { kind: 'malformed'; message: string }
  | { kind: 'token-missing'; record: DaemonRecordBase }
  | { kind: 'valid'; record: DaemonRecord }

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

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'malformed', message: 'Daemon record is not an object.' }
  }

  const fullResult = daemonRecordSchema.safeParse(parsed)
  if (fullResult.success) {
    return { kind: 'valid', record: fullResult.data }
  }

  // The full schema also fails for missing/empty token, so re-check against
  // the token-less base schema to distinguish "token missing" (a record we
  // can still report on) from genuinely malformed data. The base schema
  // strips `token` entirely, so a present-but-wrong-typed token (e.g. a
  // number) would slip through as token-missing — guard that explicitly so it
  // is reported as malformed instead.
  const token = (parsed as Record<string, unknown>).token
  const tokenIsAbsentOrEmpty = token === undefined || token === ''
  const baseResult = daemonRecordBaseSchema.safeParse(parsed)
  if (baseResult.success && tokenIsAbsentOrEmpty) {
    return { kind: 'token-missing', record: baseResult.data }
  }

  return { kind: 'malformed', message: 'Daemon record is missing required fields.' }
}
