// Server-mode process record: written by `whiteboard server run` on startup,
// read by `whiteboard server status / stop`.
//
// Security constraints:
//   - JWKS URI, JWT issuer/audience, credentials, tokens, and filesystem paths
//     MUST NOT appear in the record. Only fields needed for operational
//     identification (pid, host, port, publicBaseUrl, authStrategy, startedAt)
//     are stored.
//   - Parent data directory is created with mode 0o700 (owner-only); existing
//     directories are also tightened to 0o700 via chmodSync.
//   - Written with mode 0o600 (owner-only read/write).
//   - Read path is side-effect-free (no mkdirSync, no probe).

import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

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
  | { kind: 'malformed' }

export function readServerModeRecord(dataDir: string): ServerModeRecordReadResult {
  const path = getServerModeRecordPath(dataDir)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { kind: 'missing' }
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
  const path = getServerModeRecordPath(dataDir)
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // chmodSync re-establishes 0o700 on pre-existing directories: mkdirSync's
  // mode option only applies when creating; existing dirs keep their bits.
  if (process.platform !== 'win32') {
    try {
      chmodSync(dir, 0o700)
    } catch {
      // Best-effort; ignore failures on systems where chmod is restricted.
    }
  }
  writeFileSync(path, JSON.stringify(record), { mode: 0o600 })
  // chmodSync re-establishes 0o600 on pre-existing files: writeFileSync's
  // mode option only applies when creating; existing files keep their bits.
  chmodSync(path, 0o600)
}

export function deleteServerModeRecord(dataDir: string): void {
  try {
    unlinkSync(getServerModeRecordPath(dataDir))
  } catch {
    // Best-effort; ignore ENOENT and other errors.
  }
}
