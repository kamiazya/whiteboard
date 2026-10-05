/**
 * What one body-growing write costs on each editor sync route, through the
 * real store (libsql, the workspace record, the CRDT merge).
 *
 * Run:
 *   node --import tsx/esm scripts/measure/sync-update-body-cost.mjs [chars...]
 *
 * Three writes, each inserting N characters of prose into a markdown body
 * that already exists:
 *
 *   document    applyDocumentUpdate        POST /api/w/:ws/document/<path>/update
 *   workspace   applyWorkspaceDocumentUpdate POST /api/w/:ws/workspace-document/update
 *   promote     promoteWorkspace           POST /api/w/:ws/workspace-document/promote
 *
 * and, for each, the CPU the operation spent and what it answered. CPU rather
 * than wall time: the import is one synchronous WASM call, so CPU is the
 * time the daemon's loop is held, and wall time adds whoever else is running.
 *
 * The `engine` rows split the cost model the limit rests on. Loro imports ONE
 * contiguous insert run into a non-empty document in time quadratic in that
 * run's length; the same characters arriving as several separate runs, or
 * into a DETACHED document (oplog only, no state), cost a small fraction.
 * That is what makes reading an update's inserts before applying it
 * affordable.
 *
 * THE PREFLIGHT IS NOT CEREMONY: every write is read back, so a harness whose
 * write silently landed nowhere cannot print a plausible small number. A row
 * whose body did not change, and was not refused, exits 1.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readMarkdownBody,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import {
  applyDocumentUpdate,
  applyWorkspaceDocumentUpdate,
  promoteWorkspace,
  wbDocumentCreate,
} from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { bootSelfHostDeps } from '../../src/di/boot-self-host-deps.ts'
import { disposeAutoCompact, uninstallAutoCompact } from '../../src/server/store/auto-compact.ts'
import { clearDbCacheForTests, closeDb } from '../../src/server/store/db/index.ts'
import { clearDocCacheForTests } from '../../src/server/store/doc-cache.ts'
import { _clearWorkspaceDocCacheForTests } from '../../src/server/store/workspace-doc-cache.ts'
import { resetDataDirForTests, setDataDirForTests } from '../../src/shared/data-dir-secure.ts'

const SIZES = process.argv.slice(2).map(Number)
const CHARS = SIZES.length > 0 ? SIZES : [64 * 1024, 128 * 1024, 256 * 1024, 384 * 1024]
const OPERATOR = { kind: 'human', displayName: 'measure' }
const BASE_BODY = 'An existing body.'

function prose(length) {
  const paragraph = `${'The quick brown fox jumps over the lazy dog. '.repeat(20)}\n\n`
  return paragraph.repeat(Math.ceil(length / paragraph.length)).slice(0, length)
}

async function cpu(run) {
  const before = process.cpuUsage()
  let outcome
  try {
    outcome = await run()
  } catch (err) {
    outcome = `threw ${err?.constructor?.name}: ${String(err?.message).slice(0, 80)}`
  }
  const spent = process.cpuUsage(before)
  return { cpuMs: Math.round((spent.user + spent.system) / 1000), outcome }
}

/** A fresh daemon store per row, so no row inherits another's record. */
async function withStore(work) {
  const served = await mkdtemp(join(tmpdir(), 'wb-sync-cost-'))
  const ambient = await mkdtemp(join(tmpdir(), 'wb-sync-cost-ambient-'))
  setDataDirForTests(ambient)
  try {
    const { serverDeps } = await bootSelfHostDeps(served)
    await serverDeps.documentIndex.createWorkspace({ workspaceId: 'ws' })
    return await work(serverDeps)
  } finally {
    uninstallAutoCompact()
    await disposeAutoCompact()
    clearDocCacheForTests()
    _clearWorkspaceDocCacheForTests()
    await closeDb(served)
    clearDbCacheForTests()
    resetDataDirForTests()
    await rm(served, { recursive: true, force: true })
    await rm(ambient, { recursive: true, force: true })
  }
}

async function seeded(deps) {
  const { documentId } = await wbDocumentCreate(deps, {
    workspaceId: 'ws',
    path: 'notes',
    kind: 'markdown',
    markdown: BASE_BODY,
  })
  return documentId
}

/** The body as stored, read the way every reader reads it. */
async function storedBodyLength(deps) {
  return readMarkdownBody(await deps.liveDocuments.get('ws', 'notes')).length
}

async function documentRow(chars) {
  return withStore(async (deps) => {
    await seeded(deps)
    const client = (await deps.liveDocuments.get('ws', 'notes')).fork()
    const from = client.oplogVersion()
    client.getText('body').insert(0, prose(chars))
    client.commit()
    const update = client.export({ mode: 'update', from })
    const bodyBefore = await storedBodyLength(deps)
    const { cpuMs, outcome } = await cpu(async () => {
      await applyDocumentUpdate(deps, { workspaceId: 'ws', path: 'notes', update })
      return 'applied'
    })
    return {
      cpuMs,
      outcome,
      bodyBefore,
      bodyAfter: await storedBodyLength(deps),
      bytes: update.length,
    }
  })
}

async function workspaceRow(chars) {
  return withStore(async (deps) => {
    const documentId = await seeded(deps)
    const client = (await deps.workspaceDocuments.get('ws')).fork()
    const from = client.oplogVersion()
    documentContainers(client, documentId).getText('body').insert(0, prose(chars))
    client.commit()
    const update = client.export({ mode: 'update', from })
    const bodyBefore = await storedBodyLength(deps)
    const { cpuMs, outcome } = await cpu(() =>
      applyWorkspaceDocumentUpdate(deps, { workspaceId: 'ws', update }),
    )
    return {
      cpuMs,
      outcome,
      bodyBefore,
      bodyAfter: await storedBodyLength(deps),
      bytes: update.length,
    }
  })
}

async function promoteRow(chars) {
  return withStore(async (deps) => {
    await seeded(deps)
    // A browser keeper's record holding one document with that body.
    const record = new LoroDoc()
    const documentId = generateDocumentId()
    createWorkspaceDocumentAtPath(record, { path: 'promoted', documentId, kind: 'markdown' })
    writeMarkdownBody(documentContainers(record, documentId), prose(chars))
    const snapshot = record.export({ mode: 'snapshot' })
    const { cpuMs, outcome } = await cpu(async () => {
      const result = await promoteWorkspace(deps, {
        workspaceId: 'ws',
        snapshot,
        operator: OPERATOR,
      })
      return result.kind
    })
    const promoted = (await deps.liveDocuments.exists('ws', 'promoted'))
      ? readMarkdownBody(await deps.liveDocuments.get('ws', 'promoted')).length
      : 0
    return { cpuMs, outcome, bodyBefore: 0, bodyAfter: promoted, bytes: snapshot.length }
  })
}

/** The bare engine, to show which shape of write the cost follows. */
function engineRows(chars) {
  const target = new LoroDoc()
  target.getText('body').insert(0, BASE_BODY)
  target.commit()
  // Forked from the target, so the update depends on nothing it lacks and is
  // applied rather than parked as pending.
  const updateOf = (pieces) => {
    const client = target.fork()
    const from = client.oplogVersion()
    const text = client.getText('body')
    // Each piece into the MIDDLE of the last: adjacent inserts by one peer
    // merge into one run, which the engine then charges as one insert.
    for (let i = 0; i < pieces; i += 1)
      text.insert(Math.floor(text.length / 2), prose(chars / pieces))
    client.commit()
    return client.export({ mode: 'update', from })
  }
  const into = (update, detached) => {
    const doc = target.fork()
    if (detached) doc.detach()
    const before = process.cpuUsage()
    doc.import(update)
    const spent = process.cpuUsage(before)
    if (doc.oplogVersion().compare(target.oplogVersion()) !== 1) {
      console.error('preflight: an engine update was not applied')
      process.exit(1)
    }
    return Math.round((spent.user + spent.system) / 1000)
  }
  const one = updateOf(1)
  const sixteen = updateOf(16)
  return {
    oneInsert: into(one, false),
    sixteenRuns: into(sixteen, false),
    oneInsertDetached: into(one, true),
  }
}

const rows = []
for (const chars of CHARS) {
  for (const [route, run] of [
    ['document', documentRow],
    ['workspace', workspaceRow],
    ['promote', promoteRow],
  ]) {
    const row = await run(chars)
    const landed = row.bodyAfter === row.bodyBefore + chars
    const refused =
      typeof row.outcome === 'string' && row.outcome !== 'applied' && row.outcome !== 'promoted'
    if (!landed && !refused) {
      console.error(`preflight: ${route} at ${chars} neither landed nor was refused`, row)
      process.exit(1)
    }
    rows.push({ chars, route, ...row })
    console.log(JSON.stringify(rows.at(-1)))
  }
  console.log(JSON.stringify({ chars, route: 'engine (cpu ms)', ...engineRows(chars) }))
}
