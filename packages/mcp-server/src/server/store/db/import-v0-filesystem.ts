import { mkdir, readdir, readFile, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import type { Database } from './index.js'
import { quarantine } from './quarantine.js'

// One-shot importer that converts the legacy filesystem layout (~/.whiteboard
// pre-sqlite) into rows in the freshly-initialized DB plus content blobs in
// {dataDir}/blobs/. Idempotent: re-running after a complete import yields
// zero new rows because workspace inserts use ON CONFLICT IGNORE and the
// quarantine helper short-circuits on already-recorded entries.
//
// The importer never deletes user data. Source files are renamed into
// .legacy-bak/v0-filesystem/{scope}/{key} buckets via the quarantine helper
// after the corresponding DB rows are committed.

const NANOID_PATTERN = /^[A-Za-z0-9_-]{21}$/

const QUARANTINE_KIND = 'v0-filesystem'

interface NamesFile {
  workspace?: string
  canvases?: Record<string, string>
  pinned?: string[]
}

interface BranchesFile {
  head?: string
  branches?: Array<{
    name?: string
    tipFrontiers?: string
    color?: string
    sourceBranchName?: string
    sourceVersionId?: string
    createdAt?: string
  }>
}

interface VersionMetaFile {
  id?: string
  branchName?: string
  auto?: boolean
  label?: string
  operator?: {
    kind?: 'ai' | 'human' | 'system'
    peerId?: string
    displayName?: string
    agentId?: string
    workspaceId?: string
  }
  sizeBytes?: number
  elementCount?: number
  frontiers?: string
  hasThumbnail?: boolean
  createdAt?: string
}

export interface ImportSummary {
  importedWorkspaces: number
  skippedNonNanoidDirs: string[]
}

interface ImportContext {
  db: Database
  dataDir: string
  blobsRoot: string
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    const raw = await readFile(p, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function workspaceCreatedAt(workspaceDir: string): Promise<number> {
  try {
    const s = await stat(workspaceDir)
    return Math.floor(s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs)
  } catch {
    return Date.now()
  }
}

async function moveBlob(src: string, dest: string): Promise<void> {
  await mkdir(join(dest, '..'), { recursive: true })
  await rename(src, dest)
}

async function ensureCanvasRow(
  ctx: ImportContext,
  workspaceId: string,
  slug: string,
  values: {
    displayName: string | null
    isPinned: 0 | 1
    pinOrder: number | null
    createdAt: number
    updatedAt: number
  },
  slugToId: Map<string, string>,
): Promise<string> {
  // Insert if missing, then resolve the canvas id back. Using a manual
  // existence check here avoids relying on RETURNING which libsql does not
  // currently surface uniformly.
  const existing = await ctx.db
    .selectFrom('canvases')
    .select(['id'])
    .where('workspaceId', '=', workspaceId)
    .where('slug', '=', slug)
    .executeTakeFirst()
  if (existing) {
    slugToId.set(slug, existing.id)
    return existing.id
  }
  const id = nanoid(12)
  await ctx.db
    .insertInto('canvases')
    .values({
      id,
      workspaceId,
      slug,
      displayName: values.displayName,
      isPinned: values.isPinned,
      pinOrder: values.pinOrder,
      currentBranch: 'main',
      createdAt: values.createdAt,
      updatedAt: values.updatedAt,
    })
    .onConflict((oc) => oc.columns(['workspaceId', 'slug']).doNothing())
    .execute()
  // Re-read in case a concurrent insert won the race.
  const row = await ctx.db
    .selectFrom('canvases')
    .select(['id'])
    .where('workspaceId', '=', workspaceId)
    .where('slug', '=', slug)
    .executeTakeFirst()
  const resolved = row?.id ?? id
  slugToId.set(slug, resolved)
  return resolved
}

async function importWorkspace(ctx: ImportContext, workspaceId: string): Promise<void> {
  const workspaceDir = join(ctx.dataDir, workspaceId)
  const createdAt = await workspaceCreatedAt(workspaceDir)
  const now = Date.now()

  const names = await readJson<NamesFile>(join(workspaceDir, '.names.json'))

  // ── workspaces row ─────────────────────────────────────────────
  await ctx.db
    .insertInto('workspaces')
    .values({
      id: workspaceId,
      displayName: names?.workspace ?? null,
      createdAt,
      updatedAt: now,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute()

  // ── canvases rows (one per *.loro at the workspace root) ───────
  const entries = await readdir(workspaceDir, { withFileTypes: true }).catch(
    () => [] as Array<import('node:fs').Dirent>,
  )
  const canvasFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.loro'))
  const pinnedSlugs = names?.pinned ?? []
  const blobWorkspaceRoot = join(ctx.blobsRoot, workspaceId)
  const slugToCanvasId = new Map<string, string>()

  for (const entry of canvasFiles) {
    const slug = entry.name.replace(/\.loro$/, '')
    const isPinned = pinnedSlugs.includes(slug)
    const pinOrder = isPinned ? pinnedSlugs.indexOf(slug) : null
    const canvasId = await ensureCanvasRow(
      ctx,
      workspaceId,
      slug,
      {
        displayName: names?.canvases?.[slug] ?? null,
        isPinned: isPinned ? 1 : 0,
        pinOrder,
        createdAt,
        updatedAt: now,
      },
      slugToCanvasId,
    )

    const src = join(workspaceDir, entry.name)
    const dest = join(blobWorkspaceRoot, 'canvas', `${canvasId}.loro`)
    if (await pathExists(src)) {
      await mkdir(join(blobWorkspaceRoot, 'canvas'), { recursive: true })
      await rename(src, dest)
    }
  }

  // Hierarchical canvases also use slashes inside slug; those are stored as
  // nested directories with .loro files at the leaves. Walk the immediate
  // subdirectories that are not reserved (versions/exports/branches).
  const RESERVED_DIRS = new Set(['versions', 'exports', 'branches', 'files'])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue
    if (RESERVED_DIRS.has(entry.name)) continue
    await importNestedCanvases(
      ctx,
      workspaceId,
      workspaceDir,
      entry.name,
      names,
      createdAt,
      slugToCanvasId,
    )
  }

  async function resolveCanvasId(slug: string): Promise<string | null> {
    const cached = slugToCanvasId.get(slug)
    if (cached) return cached
    const row = await ctx.db
      .selectFrom('canvases')
      .select(['id'])
      .where('workspaceId', '=', workspaceId)
      .where('slug', '=', slug)
      .executeTakeFirst()
    if (row) {
      slugToCanvasId.set(slug, row.id)
      return row.id
    }
    return null
  }

  // ── branches rows ─────────────────────────────────────────────
  const branchesDir = join(workspaceDir, 'branches')
  if (await pathExists(branchesDir)) {
    const branchFiles = await readdir(branchesDir).catch(() => [] as string[])
    for (const file of branchFiles) {
      if (!file.endsWith('.json')) continue
      const slug = file.replace(/\.json$/, '')
      const branchesFile = await readJson<BranchesFile>(join(branchesDir, file))
      if (!branchesFile?.branches) continue
      const canvasId = await resolveCanvasId(slug)
      if (!canvasId) continue
      for (const b of branchesFile.branches) {
        if (!b.name || typeof b.tipFrontiers !== 'string') continue
        await ctx.db
          .insertInto('branches')
          .values({
            canvasId,
            name: b.name,
            tipFrontiers: b.tipFrontiers,
            color: b.color ?? null,
            sourceBranchName: b.sourceBranchName ?? null,
            sourceVersionId: b.sourceVersionId ?? null,
            createdAt: parseIso(b.createdAt) ?? createdAt,
          })
          .onConflict((oc) => oc.columns(['canvasId', 'name']).doNothing())
          .execute()
      }
      if (branchesFile.head) {
        await ctx.db
          .updateTable('canvases')
          .set({ currentBranch: branchesFile.head })
          .where('id', '=', canvasId)
          .execute()
      }
    }
    await quarantine({
      db: ctx.db,
      dataDir: ctx.dataDir,
      kind: QUARANTINE_KIND,
      scope: workspaceId,
      key: 'branches',
      sourcePath: branchesDir,
    })
  }

  // ── versions rows + blob move ─────────────────────────────────
  const versionsDir = join(workspaceDir, 'versions')
  if (await pathExists(versionsDir)) {
    const versionFiles = await readdir(versionsDir).catch(() => [] as string[])
    const blobVersionsDir = join(blobWorkspaceRoot, 'versions')
    for (const file of versionFiles) {
      if (!file.endsWith('.json')) continue
      const meta = await readJson<VersionMetaFile>(join(versionsDir, file))
      if (!meta?.id || !meta.frontiers) continue
      const slug = (meta as { slug?: string }).slug
      if (typeof slug !== 'string' || slug.length === 0) continue
      const canvasId = await resolveCanvasId(slug)
      if (!canvasId) continue
      await ctx.db
        .insertInto('versions')
        .values({
          id: meta.id,
          canvasId,
          branchName: meta.branchName ?? 'main',
          auto: meta.auto ? 1 : 0,
          label: meta.label ?? null,
          operatorKind: meta.operator?.kind ?? 'system',
          operatorPeerId: meta.operator?.peerId ?? '',
          operatorDisplayName: meta.operator?.displayName ?? null,
          operatorAgentId: meta.operator?.agentId ?? null,
          operatorWorkspaceId: meta.operator?.workspaceId ?? null,
          sizeBytes: meta.sizeBytes ?? 0,
          elementCount: typeof meta.elementCount === 'number' ? meta.elementCount : 0,
          frontiers: meta.frontiers,
          hasThumbnail: meta.hasThumbnail ? 1 : 0,
          createdAt: parseIso(meta.createdAt) ?? createdAt,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute()
    }
    // Move the whole versions/ directory wholesale (preserves thumbnails and
    // any future blob content alongside the metadata files).
    if (await pathExists(versionsDir)) {
      await mkdir(blobVersionsDir, { recursive: true })
      const versionEntries = await readdir(versionsDir).catch(() => [] as string[])
      for (const f of versionEntries) {
        const src = join(versionsDir, f)
        const dst = join(blobVersionsDir, f)
        if (await pathExists(src)) await rename(src, dst)
      }
      await quarantine({
        db: ctx.db,
        dataDir: ctx.dataDir,
        kind: QUARANTINE_KIND,
        scope: workspaceId,
        key: 'versions-dir-shell',
        sourcePath: versionsDir,
      })
    }
  }

  // ── exports/ moved as content blobs ───────────────────────────
  const exportsDir = join(workspaceDir, 'exports')
  if (await pathExists(exportsDir)) {
    const blobExportsDir = join(blobWorkspaceRoot, 'exports')
    await mkdir(blobExportsDir, { recursive: true })
    const exportEntries = await readdir(exportsDir).catch(() => [] as string[])
    for (const f of exportEntries) {
      const src = join(exportsDir, f)
      const dst = join(blobExportsDir, f)
      if (await pathExists(src)) await rename(src, dst)
    }
    await quarantine({
      db: ctx.db,
      dataDir: ctx.dataDir,
      kind: QUARANTINE_KIND,
      scope: workspaceId,
      key: 'exports-dir-shell',
      sourcePath: exportsDir,
    })
  }

  // ── files/ also moved as content blobs ────────────────────────
  const filesDir = join(workspaceDir, 'files')
  if (await pathExists(filesDir)) {
    const blobFilesDir = join(blobWorkspaceRoot, 'files')
    await mkdir(blobFilesDir, { recursive: true })
    const fileEntries = await readdir(filesDir).catch(() => [] as string[])
    for (const f of fileEntries) {
      const src = join(filesDir, f)
      const dst = join(blobFilesDir, f)
      if (await pathExists(src)) await rename(src, dst)
    }
    await quarantine({
      db: ctx.db,
      dataDir: ctx.dataDir,
      kind: QUARANTINE_KIND,
      scope: workspaceId,
      key: 'files-dir-shell',
      sourcePath: filesDir,
    })
  }

  // ── palette.json ─────────────────────────────────────────────
  const palette = await readJson<Record<string, string>>(join(workspaceDir, 'palette.json'))
  if (palette) {
    for (const [key, value] of Object.entries(palette)) {
      if (typeof value !== 'string') continue
      await ctx.db
        .insertInto('palette')
        .values({ workspaceId, key, value })
        .onConflict((oc) => oc.columns(['workspaceId', 'key']).doNothing())
        .execute()
    }
    await quarantine({
      db: ctx.db,
      dataDir: ctx.dataDir,
      kind: QUARANTINE_KIND,
      scope: workspaceId,
      key: 'palette.json',
      sourcePath: join(workspaceDir, 'palette.json'),
    })
  }

  // ── .libraries.json ──────────────────────────────────────────
  const libs = await readJson<{ urls?: string[] }>(join(workspaceDir, '.libraries.json'))
  if (libs?.urls?.length) {
    for (const url of libs.urls) {
      if (typeof url !== 'string') continue
      await ctx.db
        .insertInto('installed_libraries')
        .values({ workspaceId, url, installedAt: now })
        .onConflict((oc) => oc.columns(['workspaceId', 'url']).doNothing())
        .execute()
    }
    await quarantine({
      db: ctx.db,
      dataDir: ctx.dataDir,
      kind: QUARANTINE_KIND,
      scope: workspaceId,
      key: '.libraries.json',
      sourcePath: join(workspaceDir, '.libraries.json'),
    })
  }

  // ── .names.json (kept for last so we can re-read on retry) ──
  if (await pathExists(join(workspaceDir, '.names.json'))) {
    await quarantine({
      db: ctx.db,
      dataDir: ctx.dataDir,
      kind: QUARANTINE_KIND,
      scope: workspaceId,
      key: '.names.json',
      sourcePath: join(workspaceDir, '.names.json'),
    })
  }
}

async function importNestedCanvases(
  ctx: ImportContext,
  workspaceId: string,
  workspaceDir: string,
  topSegment: string,
  names: NamesFile | null,
  createdAt: number,
  slugToCanvasId: Map<string, string>,
): Promise<void> {
  // Walk topSegment recursively, collect every .loro leaf, derive slug from
  // path relative to the workspace root, and insert + move the file.
  const stack: string[] = [topSegment]
  while (stack.length > 0) {
    const rel = stack.pop()!
    const abs = join(workspaceDir, rel)
    const entries = await readdir(abs, { withFileTypes: true }).catch(
      () => [] as Array<import('node:fs').Dirent>,
    )
    for (const e of entries) {
      const childRel = `${rel}/${e.name}`
      if (e.isDirectory()) {
        stack.push(childRel)
        continue
      }
      if (!e.name.endsWith('.loro')) continue
      const slug = childRel.replace(/\.loro$/, '')
      const isPinned = (names?.pinned ?? []).includes(slug)
      const pinOrder = isPinned ? (names?.pinned ?? []).indexOf(slug) : null
      const now = Date.now()
      const canvasId = await ensureCanvasRow(
        ctx,
        workspaceId,
        slug,
        {
          displayName: names?.canvases?.[slug] ?? null,
          isPinned: isPinned ? 1 : 0,
          pinOrder,
          createdAt,
          updatedAt: now,
        },
        slugToCanvasId,
      )
      const src = join(workspaceDir, childRel)
      const dst = join(ctx.blobsRoot, workspaceId, 'canvas', `${canvasId}.loro`)
      if (await pathExists(src)) {
        await moveBlob(src, dst)
      }
    }
  }
  // After the .loro leaves are moved out, quarantine the now-empty top dir.
  await quarantine({
    db: ctx.db,
    dataDir: ctx.dataDir,
    kind: QUARANTINE_KIND,
    scope: workspaceId,
    key: `nested-canvas-shell:${topSegment}`,
    sourcePath: join(workspaceDir, topSegment),
  })
}

function parseIso(s: string | undefined): number | null {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

async function importRuntimeMarkers(ctx: ImportContext): Promise<void> {
  const current = await readFile(join(ctx.dataDir, '.current-workspace'), 'utf-8').catch(() => null)
  if (current && current.trim().length > 0) {
    const now = Date.now()
    await ctx.db
      .insertInto('runtime')
      .values({ key: 'currentWorkspaceId', value: current.trim(), updatedAt: now })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: current.trim(), updatedAt: now }))
      .execute()
  }
  for (const name of ['.current-workspace', '.latest-session', 'daemon.json']) {
    const src = join(ctx.dataDir, name)
    if (!(await pathExists(src))) continue
    await quarantine({
      db: ctx.db,
      dataDir: ctx.dataDir,
      kind: QUARANTINE_KIND,
      scope: '_root',
      key: name,
      sourcePath: src,
    })
  }
}

async function importUserLibraries(ctx: ImportContext): Promise<void> {
  const dir = join(ctx.dataDir, '.user-libraries')
  if (!(await pathExists(dir))) return
  const blobsDir = join(ctx.blobsRoot, '.user-libraries')
  await mkdir(blobsDir, { recursive: true })
  const entries = await readdir(dir, { withFileTypes: true }).catch(
    () => [] as Array<import('node:fs').Dirent>,
  )
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (entry.name.endsWith('.excalidrawlib')) {
      const name = entry.name.replace(/\.excalidrawlib$/, '')
      await ctx.db
        .insertInto('user_libraries')
        .values({ name, itemCount: null, createdAt: now, updatedAt: now })
        .onConflict((oc) => oc.column('name').doNothing())
        .execute()
      await rename(join(dir, entry.name), join(blobsDir, entry.name))
    } else if (entry.name.endsWith('.meta.json')) {
      const name = entry.name.replace(/\.meta\.json$/, '')
      const manifest = await readFile(join(dir, entry.name), 'utf-8').catch(() => null)
      if (manifest === null) continue
      await ctx.db
        .insertInto('user_libraries')
        .values({ name, itemCount: null, createdAt: now, updatedAt: now })
        .onConflict((oc) => oc.column('name').doNothing())
        .execute()
      await ctx.db
        .insertInto('user_library_metadata')
        .values({ name, manifestJson: manifest, updatedAt: now })
        .onConflict((oc) =>
          oc.column('name').doUpdateSet({ manifestJson: manifest, updatedAt: now }),
        )
        .execute()
      await rename(join(dir, entry.name), join(blobsDir, entry.name))
    }
  }
  await quarantine({
    db: ctx.db,
    dataDir: ctx.dataDir,
    kind: QUARANTINE_KIND,
    scope: '_root',
    key: '.user-libraries',
    sourcePath: dir,
  })
}

export async function importV0Filesystem(opts: {
  db: Database
  dataDir: string
}): Promise<ImportSummary> {
  const blobsRoot = join(opts.dataDir, 'blobs')
  await mkdir(blobsRoot, { recursive: true })
  const ctx: ImportContext = { db: opts.db, dataDir: opts.dataDir, blobsRoot }

  const summary: ImportSummary = {
    importedWorkspaces: 0,
    skippedNonNanoidDirs: [],
  }

  let entries: Array<import('node:fs').Dirent>
  try {
    entries = await readdir(opts.dataDir, { withFileTypes: true })
  } catch {
    return summary
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue
    if (entry.name === 'blobs') continue
    if (!NANOID_PATTERN.test(entry.name)) {
      summary.skippedNonNanoidDirs.push(entry.name)
      continue
    }
    await importWorkspace(ctx, entry.name)
    summary.importedWorkspaces += 1
  }

  await importRuntimeMarkers(ctx)
  await importUserLibraries(ctx)

  return summary
}
