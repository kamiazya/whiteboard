import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_DIR } from '../config.js'
import { validateWorkspaceId } from '../validators.js'
import { assertPathWithinDir } from './path-guard.js'
import { corruptStoredData, isMissingFileError } from './corrupt-stored-data.js'

const FILE_NAME = 'palette.json'

function sessionDir(workspaceId: string): string {
  validateWorkspaceId(workspaceId)
  const dir = join(DATA_DIR, workspaceId)
  return assertPathWithinDir(dir, DATA_DIR, 'session path')
}

function palettePath(workspaceId: string): string {
  return assertPathWithinDir(join(sessionDir(workspaceId), FILE_NAME), DATA_DIR, 'session path')
}

function parsePalette(path: string, raw: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw corruptStoredData(path, 'expected valid palette JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw corruptStoredData(path, 'expected palette object')
  }
  const entries = Object.entries(parsed as Record<string, unknown>)
  if (entries.some(([, value]) => typeof value !== 'string')) {
    throw corruptStoredData(path, 'expected palette values to be strings')
  }
  return Object.fromEntries(entries) as Record<string, string>
}

async function savePalette(workspaceId: string, palette: Record<string, string>): Promise<void> {
  const dir = sessionDir(workspaceId)
  await mkdir(dir, { recursive: true })
  await writeFile(palettePath(workspaceId), JSON.stringify(palette, null, 2))
}

export async function loadPalette(workspaceId: string): Promise<Record<string, string>> {
  const path = palettePath(workspaceId)
  try {
    const raw = await readFile(path, 'utf-8')
    return parsePalette(path, raw)
  } catch (error) {
    if (isMissingFileError(error)) return {}
    throw error
  }
}

export async function mergePaletteEntries(
  workspaceId: string,
  entries: Record<string, string>,
): Promise<Record<string, string>> {
  const current = await loadPalette(workspaceId)
  const next = { ...current, ...entries }
  await savePalette(workspaceId, next)
  return next
}

export async function deletePaletteEntries(
  workspaceId: string,
  keys: string[],
): Promise<Record<string, string>> {
  const current = await loadPalette(workspaceId)
  const next = { ...current }
  for (const key of keys) delete next[key]
  await savePalette(workspaceId, next)
  return next
}
