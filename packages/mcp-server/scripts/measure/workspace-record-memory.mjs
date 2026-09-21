/**
 * How much memory a live workspace-record `LoroDoc` occupies, against the
 * ceiling a Cloudflare Durable Object isolate imposes.
 *
 * WHY THIS EXISTS. ADR-0044 defers its promotion-band threshold as "one
 * measurement away", and a per-workspace Durable Object keeper is only worth
 * building if a realistic workspace fits an isolate at all. Nothing in this
 * repository measured memory before this file: a grep for `memoryUsage`,
 * `expose-gc` or `NODE_OPTIONS` returned zero hits.
 *
 * Run:
 *   node --expose-gc --import tsx/esm scripts/measure/workspace-record-memory.mjs
 *
 * ONE COUNT PER PROCESS, and that is the whole reason this file spawns
 * itself. The first version measured every count in one process, reading a
 * fresh baseline before each. Because WASM linear memory never shrinks and
 * `free()` only returns space for REUSE, that baseline already contained
 * every earlier row's high-water mark, so each figure was the MARGINAL new
 * grant at that point in a growing process rather than that count's
 * footprint — and the column said "live WASM". It reported 47MB for 360
 * documents and 182MB for 720, a per-document cost that appeared to
 * quadruple, and neither number could be compared against a 128MB cap.
 * A child process per count has one allocation history, so its high-water
 * mark IS the footprint.
 *
 * WHAT IS BEING MEASURED, and why `external`.
 *
 * Loro is WebAssembly, so a document's bytes live in the WASM linear memory
 * rather than the JS heap. Node accounts for that under
 * `process.memoryUsage().external`. Two properties of it decide how every
 * number here must be read, and both were established by experiment before
 * this file was written:
 *
 * 1. **WASM linear memory grows and never shrinks.** So `external` reports a
 *    HIGH-WATER MARK, not current usage. That is the right quantity: a 128 MB
 *    isolate cap bounds the peak, not the average.
 * 2. **`free()` returns an allocation for REUSE.** Measured: 200 documents of
 *    20 KB each grew `external` by 7.6 MB; freeing them and allocating 200
 *    more grew it by 0.0. Not calling `free()` defers to wasm-bindgen's
 *    FinalizationRegistry instead, which also returns the space, but only
 *    after a GC AND a turn of the event loop. The daemon never calls `free()`
 *    (zero call sites) and `evictWorkspaceDocCache` only drops a Map entry,
 *    so on a memory-capped runtime the peak is whatever was live at once.
 *
 * THE PREFLIGHT IS NOT CEREMONY. A harness that stops measuring keeps
 * printing plausible tables, so this one proves it can see an allocation
 * before it reports anything, and exits 1 if it cannot.
 *
 * RESOLUTION. `external` moves in WASM page grants, so differences under
 * ~1 MB are not measurements. Every figure is reported to 0.1 MB and no
 * claim is made on a gap smaller than 1 MB.
 *
 * WHAT IT MEASURED, 2026-09-22, on this machine (Node 24, 80 real documents
 * from `docs/`, mean 13.5KB of body, replicated to reach each count):
 *
 *     docs   bodies   snapshot   live    +export   peak    per doc
 *       45    0.6MB      1.0MB    3.8MB    5.8MB    10MB      86KB
 *       90    1.2MB      1.6MB    8.5MB   12.4MB    21MB      96KB
 *      180    2.4MB      3.2MB   21.9MB   25.5MB    47MB     125KB
 *      360    4.8MB      6.5MB   64.5MB   51.1MB   116MB     184KB
 *      720    9.5MB     12.8MB  209.8MB   88.2MB   298MB     298KB
 *
 * Three readings, none of which was the expected one:
 *
 * 1. **The cost is super-linear in DOCUMENT COUNT, not in bytes.** Per
 *    document it grows 86KB -> 298KB over that range, so "how much content"
 *    does not predict capacity and a limit stated in megabytes of content
 *    would be wrong at both ends.
 * 2. **The EXPORT is the binding cost, not the resident document.** A 6.5MB
 *    snapshot peaks at 116MB — an 18x amplification — because a keeper that
 *    answers a read materialises the bytes beside the document it read them
 *    from. A capacity rule watching resident size would pass a workspace
 *    that cannot be read.
 * 3. **So a 128MB isolate holds a few hundred documents, not a few
 *    thousand.** 360 fits with 12MB spare; 720 needs 298MB.
 *
 * WHAT IT CANNOT SHOW. The Durable Object per-instance memory limit is NOT
 * documented; 128 MB is the Workers isolate limit, and this compares against
 * that on the assumption a DO is bounded by it. And Node's allocator is not
 * workerd's, so the SHAPE of the curve transfers while the absolute numbers
 * are this machine's.
 */
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..')

const MB = 1024 * 1024
const ISOLATE_LIMIT_MB = 128
/** Differences below this are WASM page noise, not readings. */
const RESOLUTION_MB = 1

if (typeof globalThis.gc !== 'function') {
  console.error('FAIL: run with --expose-gc; without it every reading is whatever GC last did')
  process.exit(1)
}

/** External bytes, in MB, after settling the collector. */
const externalMb = () => {
  globalThis.gc()
  globalThis.gc()
  return process.memoryUsage().external / MB
}

// ---------------------------------------------------------------- preflight

function preflight() {
  const before = externalMb()
  let ballast = Buffer.alloc(64 * MB, 7)
  const held = externalMb()
  const grew = held - before
  // Read a byte back before dropping it: the allocation has to be live
  // across the reading above, and an allocation nothing ever touches is
  // one a runtime is entitled to elide.
  const witness = ballast[0]
  ballast = null
  const after = externalMb()
  const recovered = held - after
  console.log(
    `preflight  64MB allocation -> external +${grew.toFixed(1)}MB, released ${recovered.toFixed(1)}MB`,
  )
  if (witness !== 7 || grew < 60 || recovered < 60) {
    console.error('FAIL: the instrument cannot see a 64MB allocation; every table below would lie')
    process.exit(1)
  }
}

// ------------------------------------------------------------------ fixture

/**
 * A workspace record built through the REAL write path, from the repo's own
 * 45 markdown documents — mean ~2300 tokens, longest 7800 (ADR-0015). The
 * corpus is replicated to reach a target document count, so the BODIES are
 * real prose rather than `'x'.repeat(n)`, whose uniformity a rope
 * compresses differently.
 */
function buildRecord(LoroDoc, adapter, corpus, documentCount) {
  const { createWorkspaceDocumentAtPath, documentContainers, writeMarkdownBody } = adapter
  const record = new LoroDoc()
  record.setPeerId(1n)
  for (let i = 0; i < documentCount; i += 1) {
    const doc = corpus[i % corpus.length]
    const documentId = `01ARZ3NDEKTSV4RRFF${String(i).padStart(8, '0')}`
    createWorkspaceDocumentAtPath(record, {
      path: `copy${Math.floor(i / corpus.length)}/${doc.path}`,
      documentId,
      kind: 'markdown',
    })
    writeMarkdownBody(documentContainers(record, documentId), doc.body)
  }
  record.commit()
  return record
}

// ---------------------------------------------------------------------- run

/** One count, measured in this process, printed as a single row. */
async function measureOne(count) {
  const { LoroDoc } = require('loro-crdt')
  const adapter = await import('@kamiazya/whiteboard-loro-adapter')
  const { loadDocsCorpus } = await import('../../src/server/search/docs-corpus.ts')
  const corpus = loadDocsCorpus(REPO_ROOT)
  const corpusBytes = corpus.reduce((n, d) => n + Buffer.byteLength(d.body, 'utf8'), 0)

  const base = externalMb()
  const record = buildRecord(LoroDoc, adapter, corpus, count)
  const live = externalMb()
  const snapshotBytes = record.export({ mode: 'snapshot' }).byteLength
  const afterExport = externalMb()
  record.free()

  process.stdout.write(
    `${JSON.stringify({
      count,
      bodies: (corpusBytes * count) / corpus.length / MB,
      snapshot: snapshotBytes / MB,
      live: live - base,
      peak: afterExport - base,
    })}\n`,
  )
}

function runChild(count) {
  const { execFileSync } = require('node:child_process')
  const out = execFileSync(
    process.execPath,
    ['--expose-gc', '--import', 'tsx/esm', fileURLToPath(import.meta.url), String(count)],
    { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  )
  return JSON.parse(out.trim().split('\n').at(-1))
}

async function main() {
  preflight()

  const { loadDocsCorpus } = await import('../../src/server/search/docs-corpus.ts')
  const corpus = loadDocsCorpus(REPO_ROOT)
  const corpusBytes = corpus.reduce((n, d) => n + Buffer.byteLength(d.body, 'utf8'), 0)
  console.log(
    `corpus     ${corpus.length} real documents, ${(corpusBytes / 1024).toFixed(0)}KB of bodies, ` +
      `mean ${(corpusBytes / corpus.length / 1024).toFixed(1)}KB`,
  )
  console.log(`resolution differences under ${RESOLUTION_MB}MB are WASM page noise, not readings`)
  console.log("each row is its OWN process, so its high-water mark is that count's footprint")
  console.log('')
  console.log('  docs   bodies   snapshot   live WASM   +export   peak   per doc   headroom')
  console.log('  ----   ------   --------   ---------   -------   ----   -------   --------')

  for (const count of [45, 90, 180, 360, 720, 1440, 2880]) {
    const row = runChild(count)
    const perDoc = (row.live * 1024) / count
    const fits = row.peak <= ISOLATE_LIMIT_MB
    console.log(
      `  ${String(count).padStart(4)}   ` +
        `${row.bodies.toFixed(1).padStart(5)}MB   ` +
        `${row.snapshot.toFixed(1).padStart(6)}MB   ` +
        `${row.live.toFixed(1).padStart(7)}MB   ` +
        `${(row.peak - row.live).toFixed(1).padStart(5)}MB   ` +
        `${row.peak.toFixed(0).padStart(3)}MB   ` +
        `${perDoc.toFixed(0).padStart(5)}KB   ` +
        (fits ? `${(ISOLATE_LIMIT_MB - row.peak).toFixed(0).padStart(4)}MB` : '    OVER'),
    )
    if (!fits) {
      console.log('')
      console.log(
        `  stopped: ${count} documents peak over a ${ISOLATE_LIMIT_MB}MB isolate. The PEAK is the`,
      )
      console.log('  binding figure, not the live one: a keeper that answers a read exports.')
      break
    }
  }
  console.log('')
  console.log('read the SHAPE, not the absolutes: Node is not workerd, and the DO per-instance')
  console.log('memory limit is undocumented — 128MB is the Workers isolate limit.')
}

const childCount = process.argv[2]
if (childCount === undefined) await main()
else await measureOne(Number(childCount))
