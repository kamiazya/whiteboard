import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * What every HTTP composition root has to do the same way, held structurally
 * so a new root cannot forget it.
 *
 * **Live audience.** An HTTP root mounts the sync SSE router through
 * `createApp`, so it attaches the notifier with `attachLiveAudience`; a root
 * that does not leaves every tool announcing to nobody (`wb_viewport_set`
 * answers `delivered: false` to an open page). The stdio root has no audience
 * and attaches none (`mcp/index.stdio-deps.test.ts`).
 *
 * A root is found by what it does — calling `createApp(` — rather than from a
 * list, so a third one is checked the day it appears.
 */
const SERVER_DIR = fileURLToPath(new URL('.', import.meta.url))

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

interface RootFindings {
  readonly isHttpRoot: boolean
  readonly missing: string[]
}

function inspectRoot(source: string): RootFindings {
  const code = stripComments(source)
  if (!/\bcreateApp\(/.test(code)) return { isHttpRoot: false, missing: [] }
  return {
    isHttpRoot: true,
    missing: /\battachLiveAudience\(/.test(code) ? [] : ['attachLiveAudience'],
  }
}

async function productionSources(): Promise<Array<{ file: string; source: string }>> {
  const entries = (await readdir(SERVER_DIR, { recursive: true })).map((e) =>
    e.replaceAll('\\', '/'),
  )
  const files = entries.filter(
    (e) => e.endsWith('.ts') && !/\.test\.ts$|^app\.ts$|(^|\/)_test-/.test(e),
  )
  return Promise.all(
    files.map(async (file) => ({ file, source: await readFile(join(SERVER_DIR, file), 'utf8') })),
  )
}

describe('HTTP composition roots share one live audience', () => {
  // The positive control: a checker that finds nothing anywhere passes
  // without ever reaching a root.
  it('flags a root that serves the app and attaches no audience', () => {
    expect(inspectRoot('const app = createApp({})')).toEqual({
      isHttpRoot: true,
      missing: ['attachLiveAudience'],
    })
  })

  it('does not read a comment as a call', () => {
    expect(inspectRoot('// attachLiveAudience(\nconst app = createApp({})').missing).toEqual([
      'attachLiveAudience',
    ])
  })

  it('finds both HTTP roots, and each attaches it', async () => {
    const roots = (await productionSources())
      .map(({ file, source }) => ({ file, ...inspectRoot(source) }))
      .filter((r) => r.isHttpRoot)

    expect(roots.map((r) => r.file).sort()).toEqual(['http-server.ts', 'server-mode-http.ts'])
    expect(roots.flatMap((r) => r.missing.map((m) => `${r.file}: ${m}`))).toEqual([])
  })
})
