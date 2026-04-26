import { LoroDoc } from 'loro-crdt'
import { readFile, writeFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_DIR } from '../config.js'
import { validateCheckpointId } from '../validators.js'
import { corruptStoredData, isCorruptStoredDataError, isMissingFileError } from './corrupt-stored-data.js'
import { assertPathWithinDir } from './path-guard.js'

// LoroDoc snapshot-based implementation modeled after the upstream
// excalidraw-mcp/checkpoint-store.ts.
// Store checkpoints at DATA_DIR/.checkpoints/{id}.loro so they can be restored
// across sessions, independent of the per-session directories.
// listWorkspaces already skips dot-prefixed directories, so `.checkpoints`
// never appears in the session list.

// 5 MiB limit, based on snapshot byteLength.
const MAX_CHECKPOINT_BYTES = 5 * 1024 * 1024
// Maximum retained checkpoint count. Prune the oldest when exceeded.
const MAX_FILE_CHECKPOINTS = 100

export const CHECKPOINTS_DIRNAME = '.checkpoints'

export { validateCheckpointId }

export interface CheckpointEntry {
  id: string
  updatedAt: string
}

export interface CheckpointStore {
  save(id: string, doc: LoroDoc): Promise<void>
  load(id: string): Promise<LoroDoc | null>
  list(): Promise<CheckpointEntry[]>
}

function checkpointsDir(): string {
  return assertPathWithinDir(join(DATA_DIR, CHECKPOINTS_DIRNAME), DATA_DIR, 'checkpoint path')
}

function checkpointPath(id: string): string {
  validateCheckpointId(id)
  const dir = checkpointsDir()
  const filePath = join(dir, `${id}.loro`)
  return assertPathWithinDir(filePath, dir, 'checkpoint path')
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'unknown error'
}

async function unlinkIfPresent(path: string, detail: string) {
  try {
    await unlink(path)
    return null
  } catch (error) {
    if (isMissingFileError(error)) {
      return null
    }
    return corruptStoredData(path, `${detail} (${errorMessage(error)})`)
  }
}

function logPruneErrors(scope: string, errors: Array<{ message: string }>): void {
  for (const error of errors) {
    console.error(`[${scope}] ${error.message}`)
  }
}

export async function listCheckpointPruneCandidates(
  dir: string,
): Promise<Array<{ name: string; mtime: number }>> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (error) {
    if (isMissingFileError(error)) {
      return []
    }
    throw corruptStoredData(dir, `failed to read checkpoint directory (${errorMessage(error)})`)
  }
  const files = entries.filter((f) => f.endsWith('.loro'))
  return Promise.all(
    files.map(async (f) => {
      const filePath = assertPathWithinDir(join(dir, f), dir, 'checkpoint path')
      let entryStat
      try {
        entryStat = await stat(filePath)
      } catch (error) {
        throw corruptStoredData(
          filePath,
          `failed to inspect checkpoint entry (${errorMessage(error)})`,
        )
      }
      if (!entryStat.isFile()) {
        throw corruptStoredData(filePath, 'expected regular checkpoint file')
      }
      return { name: f, mtime: entryStat.mtimeMs }
    }),
  )
}

export async function cleanupCheckpointFiles(
  dir: string,
  names: string[],
): Promise<ReturnType<typeof corruptStoredData>[]> {
  const errors: ReturnType<typeof corruptStoredData>[] = []
  for (const name of names) {
    const filePath = assertPathWithinDir(join(dir, name), dir, 'checkpoint path')
    const error = await unlinkIfPresent(filePath, 'failed to remove pruned checkpoint')
    if (error) errors.push(error)
  }
  return errors
}

export class FileCheckpointStore implements CheckpointStore {
  async save(id: string, doc: LoroDoc): Promise<void> {
    validateCheckpointId(id)
    const snapshot = doc.export({ mode: 'snapshot' }) as Uint8Array
    if (snapshot.byteLength > MAX_CHECKPOINT_BYTES) {
      throw new Error(
        `Checkpoint data exceeds ${MAX_CHECKPOINT_BYTES} byte limit (${snapshot.byteLength})`,
      )
    }
    const dir = checkpointsDir()
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, `${id}.loro`)
    assertPathWithinDir(filePath, dir, 'checkpoint path')
    await writeFile(filePath, snapshot)
    await this.prune()
  }

  async load(id: string): Promise<LoroDoc | null> {
    const filePath = checkpointPath(id)
    try {
      const bytes = await readFile(filePath)
      try {
        return LoroDoc.fromSnapshot(new Uint8Array(bytes))
      } catch (error) {
        throw corruptStoredData(
          filePath,
          `checkpoint snapshot could not be restored (${errorMessage(error)})`,
        )
      }
    } catch (error) {
      if (isMissingFileError(error)) {
        return null
      }
      if (isCorruptStoredDataError(error)) {
        throw error
      }
      throw corruptStoredData(filePath, `failed to read checkpoint snapshot (${errorMessage(error)})`)
    }
  }

  async list(): Promise<CheckpointEntry[]> {
    const dir = checkpointsDir()
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (error) {
      if (isMissingFileError(error)) {
        return []
      }
      throw corruptStoredData(dir, `failed to read checkpoint directory (${errorMessage(error)})`)
    }
    const files = entries.filter((f) => f.endsWith('.loro'))
    const meta = await Promise.all(
      files.map(async (f) => {
        const filePath = assertPathWithinDir(join(dir, f), dir, 'checkpoint path')
        let entryStat
        try {
          entryStat = await stat(filePath)
        } catch (error) {
          throw corruptStoredData(
            filePath,
            `failed to inspect checkpoint entry (${errorMessage(error)})`,
          )
        }
        if (!entryStat.isFile()) {
          throw corruptStoredData(filePath, 'expected regular checkpoint file')
        }
        return {
          id: f.replace(/\.loro$/, ''),
          mtimeMs: entryStat.mtimeMs,
        }
      }),
    )
    return meta
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map(({ id, mtimeMs }) => ({ id, updatedAt: new Date(mtimeMs).toISOString() }))
  }

  private async prune(): Promise<void> {
    const dir = checkpointsDir()
    try {
      const stats = await listCheckpointPruneCandidates(dir)
      if (stats.length <= MAX_FILE_CHECKPOINTS) return
      stats.sort((a, b) => a.mtime - b.mtime)
      const toRemove = stats.slice(0, stats.length - MAX_FILE_CHECKPOINTS)
      const errors = await cleanupCheckpointFiles(
        dir,
        toRemove.map((entry) => entry.name),
      )
      logPruneErrors('checkpoint-store prune', errors)
    } catch (error) {
      const issue = isCorruptStoredDataError(error)
        ? error
        : corruptStoredData(dir, `failed to prune checkpoints (${errorMessage(error)})`)
      logPruneErrors('checkpoint-store prune', [issue])
    }
  }
}

export class MemoryCheckpointStore implements CheckpointStore {
  private entries = new Map<string, { snapshot: Uint8Array; mtime: number }>()

  async save(id: string, doc: LoroDoc): Promise<void> {
    validateCheckpointId(id)
    const snapshot = doc.export({ mode: 'snapshot' }) as Uint8Array
    if (snapshot.byteLength > MAX_CHECKPOINT_BYTES) {
      throw new Error(
        `Checkpoint data exceeds ${MAX_CHECKPOINT_BYTES} byte limit (${snapshot.byteLength})`,
      )
    }
    this.entries.set(id, { snapshot, mtime: Date.now() })
  }

  async load(id: string): Promise<LoroDoc | null> {
    validateCheckpointId(id)
    const entry = this.entries.get(id)
    if (!entry) return null
    return LoroDoc.fromSnapshot(entry.snapshot)
  }

  async list(): Promise<CheckpointEntry[]> {
    return Array.from(this.entries.entries())
      .sort((a, b) => b[1].mtime - a[1].mtime)
      .map(([id, v]) => ({ id, updatedAt: new Date(v.mtime).toISOString() }))
  }
}
