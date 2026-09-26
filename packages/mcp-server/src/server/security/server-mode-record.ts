// Server-mode process record: written by `whiteboard server run` on startup,
// read by `whiteboard server status / stop`.
//
// Security constraints:
//   - JWKS URI, JWT issuer/audience, credentials, tokens, and filesystem paths
//     MUST NOT appear in the record. Only fields needed for operational
//     identification (pid, host, port, publicBaseUrl, authStrategy, startedAt)
//     are stored.
//   - Written owner-only, through `writeSecretFileAtomicSync` — the one
//     definition of that dance, so a correction to it reaches every file the
//     daemon writes owner-only rather than one of them. This record carries
//     no secret (see the field constraint above); what it shares with the key
//     files is the MODE, which is what that helper is about.
//   - Read path is side-effect-free (no mkdirSync, no probe).

import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeSecretFileAtomicSync } from './secret-file-mode.js'

export const SERVER_MODE_RECORD_SCHEMA_VERSION = 1 as const

export const serverModeRecordSchema = z.object({
  schemaVersion: z.literal(SERVER_MODE_RECORD_SCHEMA_VERSION),
  pid: z.number().int().positive(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  publicBaseUrl: z.string().url(),
  authStrategy: z.literal('oauth-jwt'),
  // ISO 8601 with timezone offset — z accepts both 'Z' and '+HH:MM' forms.
  startedAt: z.string().datetime({ offset: true }),
  // Per-process-start identifier (crypto.randomUUID), compared against
  // /api/runtime/ping's instanceId to confirm process identity without
  // trusting a pid the OS can reuse. Optional so records written by an
  // older daemon build still parse; readers must treat a missing instanceId
  // as "identity unverifiable", never as an automatic match.
  instanceId: z.string().optional(),
})

export type ServerModeRecord = z.infer<typeof serverModeRecordSchema>

export function getServerModeRecordPath(dataDir: string): string {
  return join(dataDir, 'server-mode.json')
}

export type ServerModeRecordReadResult =
  | { kind: 'ok'; record: ServerModeRecord }
  | { kind: 'missing' }
  // There, but this process cannot read it — a permission, not an absence.
  // Nothing is known about what it says, so no caller may read it as "no
  // server" nor delete it as damaged.
  | { kind: 'unreadable' }
  | { kind: 'malformed' }

export function readServerModeRecord(dataDir: string): ServerModeRecordReadResult {
  const path = getServerModeRecordPath(dataDir)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unreadable' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'malformed' }
  }
  const result = serverModeRecordSchema.safeParse(parsed)
  if (!result.success) {
    return { kind: 'malformed' }
  }
  return { kind: 'ok', record: result.data }
}

export function writeServerModeRecord(dataDir: string, record: ServerModeRecord): void {
  writeSecretFileAtomicSync(getServerModeRecordPath(dataDir), JSON.stringify(record))
}

export function deleteServerModeRecord(dataDir: string): void {
  try {
    unlinkSync(getServerModeRecordPath(dataDir))
  } catch {
    // Best-effort; ignore ENOENT and other errors.
  }
}
