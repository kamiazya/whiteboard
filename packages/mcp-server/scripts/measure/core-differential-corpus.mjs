/**
 * Whether the Rust routing core agrees with the TypeScript on REAL data: every
 * spatial document of a daemon data dir is laid out through the daemon's own
 * `wb_scene_render` path (references embedded, so a nested canvas is laid out
 * too) with the core in `differential` mode, and each reported difference is
 * collected rather than only logged.
 *
 * Run:
 *   node --import tsx/esm scripts/measure/core-differential-corpus.mjs [dataDir]
 *
 * The directory is `dataDir`, else `WHITEBOARD_DATA_DIR`, else `~/.whiteboard`.
 * The core is the one `layoutCoreLoader` loads from the staged artifact
 * (`pnpm stage:wasm`), or from `WHITEBOARD_CORE_DIR`.
 *
 * READ-ONLY BY COPY. The store layer cannot open a data dir without writing
 * (it migrates, secures and seeds the current workspace), so the directory is
 * copied whole - database, `-wal` and `-shm` - to a scratch directory and the
 * copy is opened. The original is only read.
 *
 * Exit 0: every document laid out and nothing differed. Exit 1: a difference,
 * a refusal by the core, a document that failed to read or lay out, or a data
 * dir this build refuses to open (an earlier release's). Exit 2: nothing was
 * compared - the core did not load, or no layout was routed - because
 * comparing nothing is not zero mismatches.
 */
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readSpatialCanvasWithSkipped } from '@kamiazya/whiteboard-loro-adapter'
import { reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { createCanvasRenderSvgTool } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { isRunAsScript } from '../../../../tools/checks/src/is-run-as-script.mjs'
import { bootSelfHostDeps } from '../../src/di/boot-self-host-deps.ts'
import { layoutCoreLoader, layoutCoreSettingsFrom } from '../../src/server/export/layout-core.ts'
import { closeDb } from '../../src/server/store/db/index.ts'

/** The fields of a mismatch worth reading without the whole repro. */
function summarize(mismatch) {
  return mismatch.kind === 'differs'
    ? {
        fn: mismatch.fn,
        kind: mismatch.kind,
        at: mismatch.at,
        ts: mismatch.ts[mismatch.at],
        rust: mismatch.rust[mismatch.at],
        edges: mismatch.repro.edges.length,
      }
    : {
        fn: mismatch.fn,
        kind: mismatch.kind,
        err: String(mismatch.err),
        edges: mismatch.repro.edges.length,
      }
}

/**
 * Lays out every spatial document under `dataDir` (never modified) and returns
 * what it found. `coreLoaded: false` means nothing was compared.
 * @param {{ dataDir: string, coreDir?: string }} options
 */
export async function measureCorpus({ dataDir, coreDir }) {
  const scratch = await mkdtemp(join(tmpdir(), 'wb-corpus-'))
  const copy = join(scratch, 'data')
  try {
    await cp(dataDir, copy, { recursive: true })
    const booted = await bootSelfHostDeps(copy)
    try {
      return await measureDeps(booted.serverDeps, coreDir)
    } finally {
      await closeDb(copy)
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * `base` with its routing calls counted and its reported mismatches kept
 * (summarized) instead of logged. `reset` starts a new document's tally.
 */
export function collectingCore(base) {
  let current = { mismatches: [], routed: 0 }
  return {
    core: {
      ...base,
      routing: {
        routeLayout: (...args) => {
          current.routed += 1
          return base.routing.routeLayout(...args)
        },
      },
      onMismatch: (mismatch) => current.mismatches.push(summarize(mismatch)),
    },
    reset: () => {
      current = { mismatches: [], routed: 0 }
    },
    current: () => current,
  }
}

async function measureDeps(serverDeps, coreDir) {
  const settings = layoutCoreSettingsFrom({
    WHITEBOARD_CORE: 'differential',
    // `throw` makes an unloadable artifact fail loudly instead of degrading
    // to the TypeScript; the reporter that would throw is replaced below.
    WHITEBOARD_CORE_MISMATCH: 'throw',
    ...(coreDir === undefined ? {} : { WHITEBOARD_CORE_DIR: coreDir }),
  })
  let base
  try {
    base = await layoutCoreLoader(settings)()
  } catch (err) {
    return { coreLoaded: false, coreError: String(err?.message ?? err), documents: [] }
  }
  if (base === undefined) return { coreLoaded: false, coreError: 'no core', documents: [] }

  const collecting = collectingCore(base)
  const core = collecting.core
  const deps = { ...serverDeps, layoutCore: async () => core }
  const render = createCanvasRenderSvgTool(deps)

  const documents = []
  for (const workspace of await deps.documentIndex.listWorkspaces()) {
    const entries = await deps.documentIndex.listDocuments({ workspaceId: workspace.workspaceId })
    // A document that predates kinds renders as spatial, as the tool reads it.
    for (const entry of entries.filter((e) => e.kind === undefined || e.kind === 'spatial')) {
      collecting.reset()
      const row = {
        workspace: workspace.segment ?? workspace.workspaceId,
        documentId: entry.documentId,
        nodes: 0,
        edges: 0,
        routed: 0,
        mismatches: [],
        failure: undefined,
      }
      try {
        const docRef = {
          kind: 'document',
          workspaceId: workspace.workspaceId,
          documentId: entry.documentId,
        }
        const snapshot = await deps.documentStore.loadSnapshot({ docRef })
        if (snapshot === null) throw new Error('no snapshot')
        const doc = new LoroDoc()
        doc.import(reassembleSnapshot(snapshot.manifest, snapshot.chunks))
        const { canvas } = readSpatialCanvasWithSkipped(doc)
        row.nodes = canvas.nodes.length
        row.edges = canvas.edges.length
        await render.execute({
          workspaceId: workspace.workspaceId,
          documentId: entry.documentId,
          embedReferences: true,
          comments: false,
          style: 'clean',
        })
      } catch (err) {
        row.failure = String(err?.message ?? err)
      }
      row.routed = collecting.current().routed
      row.mismatches = collecting.current().mismatches
      documents.push(row)
    }
  }
  return { coreLoaded: true, documents }
}

async function main() {
  const dataDir = resolve(
    process.argv[2] ?? process.env.WHITEBOARD_DATA_DIR ?? join(homedir(), '.whiteboard'),
  )
  let result
  try {
    result = await measureCorpus({ dataDir, coreDir: process.env.WHITEBOARD_CORE_DIR })
  } catch (err) {
    console.log(
      `the data dir could not be opened (the copy, not ${dataDir}): ${err?.message ?? err}`,
    )
    return 1
  }
  if (!result.coreLoaded) {
    console.log(`the Rust core did not load, nothing was compared: ${result.coreError}`)
    return 2
  }
  console.log(`data dir (copied, not modified): ${dataDir}`)
  for (const d of result.documents) {
    const status = d.failure === undefined ? '' : `  FAILED: ${d.failure}`
    console.log(
      `${d.workspace}  ${d.documentId}  nodes=${d.nodes} edges=${d.edges} routed=${d.routed} mismatches=${d.mismatches.length}${status}`,
    )
    for (const m of d.mismatches) console.log(`    ${JSON.stringify(m)}`)
  }
  const sum = (pick) => result.documents.reduce((n, d) => n + pick(d), 0)
  const mismatches = sum((d) => d.mismatches.length)
  const failures = result.documents.filter((d) => d.failure !== undefined).length
  console.log(
    `total: documents=${result.documents.length} nodes=${sum((d) => d.nodes)} edges=${sum((d) => d.edges)} routedLayouts=${sum((d) => d.routed)} mismatches=${mismatches} failures=${failures}`,
  )
  if (mismatches > 0 || failures > 0) return 1
  if (sum((d) => d.routed) === 0) {
    console.log('no layout was routed, so nothing was compared')
    return 2
  }
  return 0
}

if (isRunAsScript(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err)
      process.exit(1)
    },
  )
}
