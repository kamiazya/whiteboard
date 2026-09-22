import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import type { TenantDir } from '../tenant/data-layout.js'

/**
 * How a tenant's own small JSON file is written: owner-only, through a
 * temporary file and a rename, creating the tenant's directory if this is the
 * first thing in it.
 *
 * Both origin-keyed stores (pairing grants, passkey pins) wrote this by hand,
 * which is three decisions duplicated — the mode, the write-then-rename, and
 * whether the directory exists — and a keeper that has never held a blob has
 * nothing under its tenant root, so the last one is not hypothetical.
 *
 * Rename rather than a plain write: a crash mid-write would otherwise leave a
 * truncated file, and both readers degrade an unreadable file to EMPTY, so the
 * loss would be silent.
 */
export function writeTenantJsonFile(dir: TenantDir, filePath: string, payload: unknown): void {
  mkdirSync(dir, { recursive: true })
  const tmpPath = `${filePath}.tmp`
  writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { mode: 0o600 })
  renameSync(tmpPath, filePath)
}
