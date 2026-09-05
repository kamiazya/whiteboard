/**
 * The render broker's persistent tier: one file per key, under OPFS
 * (ADR-0027 decision 5).
 *
 * Addressed by the key's own path, so invalidation is the path rather than a
 * policy — a document that changed names a different file, and retiring a
 * build's whole cache is removing one directory. `renderKeyPath` builds it
 * and encodes every component the keeper supplied.
 *
 * TOTAL BY CONTRACT, in both directions. A cache that cannot read answers
 * "not there" and the caller renders; a cache that cannot write loses the
 * entry and the caller renders again next time. Neither may cost a picture,
 * so every entry point here swallows its own failure rather than surfacing
 * one — OPFS is absent on some browsers, full on some machines, and blocked
 * in some contexts, and none of those is a reason to show no thumbnail.
 *
 * JSON rather than the raw picture, and that is a correction to the ADR's
 * first sketch: what a caller needs back is the whole reply — an SVG plus
 * the bounds a consumer scales it to, or an outline's rectangles. Storing
 * only the `.svg` would mean re-deriving the extent by parsing the viewBox
 * back out, to avoid storing four numbers.
 */

/** Everything this store owns lives under one directory, so a sweep is cheap. */
const ROOT_DIR = 'render'

function storageDirectory(): Promise<FileSystemDirectoryHandle> | null {
  // `navigator.storage` is absent in some contexts and `getDirectory` in
  // others; asking for the method rather than the object is what tells the
  // two apart without throwing.
  const storage = globalThis.navigator?.storage
  if (typeof storage?.getDirectory !== 'function') return null
  return storage.getDirectory()
}

async function walk(
  from: FileSystemDirectoryHandle,
  segments: readonly string[],
  create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  let dir = from
  for (const segment of segments) {
    dir = await dir.getDirectoryHandle(segment, { create })
  }
  return dir
}

function split(path: string): { dirs: string[]; name: string } | null {
  const parts = path.split('/').filter((p) => p !== '')
  const name = parts.pop()
  if (name === undefined || parts.length === 0) return null
  return { dirs: parts, name }
}

/**
 * The stored reply for `path`, or null when there is none.
 *
 * `unknown` rather than a per-family type: the path's own `pipeline` segment
 * is what keeps two families out of one entry, exactly as it does for the
 * in-memory map, and a union here would only let a caller believe a cast had
 * been checked.
 */
export async function readRenderEntry(path: string): Promise<unknown | null> {
  const parts = split(path)
  const rootPromise = storageDirectory()
  if (parts === null || rootPromise === null) return null
  try {
    const root = await (await rootPromise).getDirectoryHandle(ROOT_DIR, { create: false })
    const dir = await walk(root, parts.dirs, false)
    if (dir === null) return null
    const file = await (await dir.getFileHandle(parts.name)).getFile()
    return JSON.parse(await file.text()) as unknown
  } catch {
    // A miss and a broken store are the same answer to a caller: render it.
    return null
  }
}

/**
 * Whether a build sweep has already run in this realm.
 *
 * Write-time rather than scheduled, per ADR-0027 decision 5: the moment a new
 * build stores its first entry is the moment the old build's directory is
 * known to be dead, and once per realm is enough because the build id cannot
 * change without a reload.
 */
let sweptBuild: string | null = null

async function sweepOtherBuilds(root: FileSystemDirectoryHandle, keep: string): Promise<void> {
  if (sweptBuild === keep) return
  sweptBuild = keep
  // `values()` is async-iterable on a directory handle; a browser without it
  // simply keeps the old directories, which costs disk and never correctness.
  const entries = (root as unknown as { values?: () => AsyncIterable<{ name: string }> }).values
  if (typeof entries !== 'function') return
  for await (const entry of entries.call(root)) {
    if (entry.name === keep) continue
    await root.removeEntry(entry.name, { recursive: true }).catch(() => undefined)
  }
}

/** Stores `value` under `path`, or does nothing if it cannot. */
export async function writeRenderEntry(path: string, value: unknown): Promise<void> {
  const parts = split(path)
  const rootPromise = storageDirectory()
  if (parts === null || rootPromise === null) return
  try {
    const root = await (await rootPromise).getDirectoryHandle(ROOT_DIR, { create: true })
    const dir = await walk(root, parts.dirs, true)
    if (dir === null) return
    const handle = await dir.getFileHandle(parts.name, { create: true })
    const writable = await handle.createWritable()
    await writable.write(JSON.stringify(value))
    await writable.close()
    const build = parts.dirs[0]
    if (build !== undefined) await sweepOtherBuilds(root, build)
  } catch {
    // Nothing to report: the render already happened and the caller has its
    // picture. Losing the entry costs one re-render on a later visit.
  }
}

/** Drops everything this store holds. For tests, and for a storage reset. */
export async function clearRenderStore(): Promise<void> {
  const rootPromise = storageDirectory()
  if (rootPromise === null) return
  sweptBuild = null
  try {
    await (await rootPromise).removeEntry(ROOT_DIR, { recursive: true })
  } catch {
    // Already absent is the state this asks for.
  }
}
