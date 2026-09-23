import { mkdir, readdir, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PENDING_WRITES_DIRNAME } from '../atomic-write.js'
import { getLogger } from '../log.js'

const log = getLogger('data-layout')

/**
 * Where a tenant's bytes live on disk, in ONE place. A tenant owns its images
 * and its workspaces' files (user decision 2026-09-23: blobs are partitioned
 * per tenant, so knowing a content digest is never a route into another
 * tenant), and every module that writes, sweeps, mirrors or restores them asks
 * here rather than joining the directory names itself —
 * `data-layout-callers.test.ts` holds that.
 *
 * The layout:
 *
 *     <dataDir>/tenants/<tenantId>/blobs/<first2Hex>/<rest>
 *     <dataDir>/tenants/<tenantId>/workspaces/<workspaceId>/files/<fileId>
 *
 * A workspace lives under `workspaces/` rather than beside `blobs/`, which
 * removes an ambiguity the flat layout had: `blobs` is a legal workspace id,
 * so `<dataDir>/blobs` was both the blob root and a possible workspace
 * directory, and the file GC sweeper told them apart by looking for a
 * `files/` child.
 *
 * Keeper-wide files — the database, the daemon identity, the macaroon root
 * key, `.pending-writes` — stay at the top of the data directory, because
 * they belong to the keeper rather than to any tenant.
 */
const TENANTS_DIRNAME = 'tenants'
const WORKSPACES_DIRNAME = 'workspaces'
const BLOBS_DIRNAME = 'blobs'
const FILES_DIRNAME = 'files'

declare const tenantDir: unique symbol

/**
 * One tenant's own directory. Branded, so a store that asks for it cannot be
 * handed the data directory by mistake — the same reason `TenantDatabase` is
 * branded, and the mistake is the same one: a path that looks right and is one
 * level too high holds every tenant's things.
 */
export type TenantDir = string & { readonly [tenantDir]: 'tenant' }

export function tenantRoot(dataDir: string, tenantId: string): TenantDir {
  return join(dataDir, TENANTS_DIRNAME, tenantId) as TenantDir
}

export function blobsRoot(dataDir: string, tenantId: string): string {
  return join(tenantRoot(dataDir, tenantId), BLOBS_DIRNAME)
}

export function workspacesRoot(dataDir: string, tenantId: string): string {
  return join(tenantRoot(dataDir, tenantId), WORKSPACES_DIRNAME)
}

export function workspaceDir(dataDir: string, tenantId: string, workspaceId: string): string {
  return join(workspacesRoot(dataDir, tenantId), workspaceId)
}

export function workspaceFilesDir(dataDir: string, tenantId: string, workspaceId: string): string {
  return join(workspaceDir(dataDir, tenantId, workspaceId), FILES_DIRNAME)
}

const KEEPER_OWNED = new Set([TENANTS_DIRNAME, PENDING_WRITES_DIRNAME, 'models'])

/**
 * Moves a data directory written before tenants existed under `tenantId`:
 * `<dataDir>/blobs` and every `<dataDir>/<workspaceId>/files` become the
 * tenant's. Idempotent — with nothing legacy left it reports nothing moved, so
 * a restart cannot drag a live tenant's directory back out.
 *
 * A legacy directory whose destination already exists is LEFT where it is and
 * reported, rather than merged: two directories holding the same workspace's
 * files is a state somebody has to look at, and a blind merge would decide
 * which copy wins.
 */
export async function moveLegacyDataDirUnderTenant(
  dataDir: string,
  tenantId: string,
  /**
   * Files at the top of the data directory that belong to the tenant, named by
   * whoever owns them — a store knows its own filename, and this module knows
   * where a tenant's things live.
   */
  options: { files: readonly string[] },
): Promise<{ blobs: boolean; workspaces: string[]; files: string[] }> {
  return {
    files: await moveTenantFiles(dataDir, tenantId, options.files),
    ...(await moveTenantDirectories(dataDir, tenantId)),
  }
}

async function moveTenantFiles(
  dataDir: string,
  tenantId: string,
  files: readonly string[],
): Promise<string[]> {
  const moved: string[] = []
  for (const name of files) {
    if (await moveFile(join(dataDir, name), join(tenantRoot(dataDir, tenantId), name))) {
      moved.push(name)
    }
  }
  return moved
}

async function moveTenantDirectories(
  dataDir: string,
  tenantId: string,
): Promise<{ blobs: boolean; workspaces: string[] }> {
  let blobs = false
  const workspaces: string[] = []
  for (const entry of await readdir(dataDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || KEEPER_OWNED.has(entry.name)) continue
    const from = join(dataDir, entry.name)
    if (entry.name === BLOBS_DIRNAME) {
      if (await moveDir(from, blobsRoot(dataDir, tenantId))) blobs = true
    } else if (await isWorkspaceDir(from)) {
      if (await moveDir(from, workspaceDir(dataDir, tenantId, entry.name))) {
        workspaces.push(entry.name)
      }
    }
  }
  return { blobs, workspaces }
}

/** A workspace directory is one with a `files/` child; anything else at the top of a data directory is not this layout's. */
async function isWorkspaceDir(dir: string): Promise<boolean> {
  return await isDirectory(join(dir, FILES_DIRNAME))
}

async function isDirectory(path: string): Promise<boolean> {
  return await stat(path)
    .then((s) => s.isDirectory())
    .catch(() => false)
}

async function moveFile(from: string, to: string): Promise<boolean> {
  if (!(await isFile(from))) return false
  if (await isFile(to)) {
    log.warning({ from, to }, 'left a legacy file in place: the tenant already holds one')
    return false
  }
  await mkdir(dirname(to), { recursive: true })
  await rename(from, to)
  return true
}

async function isFile(path: string): Promise<boolean> {
  return await stat(path)
    .then((s) => s.isFile())
    .catch(() => false)
}

async function moveDir(from: string, to: string): Promise<boolean> {
  if (await isDirectory(to)) {
    log.warning({ from, to }, 'left a legacy directory in place: the tenant already holds one')
    return false
  }
  await mkdir(dirname(to), { recursive: true })
  await rename(from, to)
  return true
}
