#!/usr/bin/env node
/**
 * How much WASM memory a live workspace-record `LoroDoc` occupies IN A
 * BROWSER TAB, and where the tab stops being able to hold one — the browser
 * keeper's counterpart of `packages/mcp-server/scripts/measure/
 * workspace-record-memory.mjs`. Read that file's header first; this one
 * inherits its reasoning and only says where the browser differs.
 *
 * WHY THIS EXISTS. ADR-0044 makes a keeper's capacity a limit the BACKEND
 * declares: at the limit a write is refused, and below it a promotion band
 * starts at the largest record whose peak still leaves room for ONE MORE
 * FULL EXPORT (2026-09-22 addendum). The first backend to declare one is the
 * browser keeper, which holds the whole workspace record as one live LoroDoc
 * in the tab's WASM memory. Its limit needs numbers taken in a browser, not
 * Node's: a different allocator, and a ceiling (wasm32's 4GiB address space,
 * the engine's own cap, the tab's process) Node does not have.
 *
 * Run (from apps/web):
 *   pnpm measure:workspace-record-memory [chromium|firefox|webkit ...]
 *
 * ONE PAGE PER COUNT, for the reason the Node file spawns itself: WASM linear
 * memory never shrinks and a freed allocation stays behind as reusable
 * space, so a page that measured two counts would report the second as a
 * MARGINAL grant. Each count gets a fresh browser context and page, hence one
 * allocation history, and its high-water mark IS that count's footprint.
 *
 * WHAT IS READ, and how it was chosen. Two readings exist:
 *
 * - the Loro instance's own `WebAssembly.Memory`, `buffer.byteLength` —
 *   captured by wrapping `WebAssembly.instantiate*` in an init script, since
 *   loro-crdt does not export it. This is the one used for every row.
 * - `performance.measureUserAgentSpecificMemory()` — Chromium only, needs
 *   cross-origin isolation (the server sends COOP/COEP for it), and it is
 *   the whole page's memory, so it cannot separate a record from the rest.
 *   The preflight reports what it saw; it is never used for a row.
 *
 * THE PREFLIGHT IS NOT CEREMONY. It runs on its own page, allocates 32MB of
 * text inside Loro, and exits 1 unless one captured memory grew by at least
 * 30MB — that is how this file knows WHICH memory is Loro's rather than
 * assuming, and that the reading moves at all.
 *
 * RESOLUTION. The memory grows in 64KiB WASM pages, and the allocator asks
 * for them in larger steps, so differences under ~1MB are not measurements.
 * Figures are reported to 0.1MB and no claim is made on a smaller gap.
 * `peak` is the high-water mark after `export({ mode: 'snapshot' })`, i.e.
 * the transient export buffers inside WASM; the exported copy itself lives
 * in the JS heap afterwards and adds `snapshot` on top.
 *
 * THE FIXTURE is the Node file's: this repo's `docs/**\/*.md`, replicated to
 * reach each count, written through `createWorkspaceDocumentAtPath` +
 * `writeMarkdownBody` — the calls the browser keeper (`browser-backend.ts`,
 * `session-body-binding.ts`) uses to place a document and write its body.
 * It commits once at the end, where the keeper commits per edit; measured in
 * Node at 360 and 720 documents, committing after every document leaves
 * live and peak unchanged to the 0.1MB, so the shortcut costs nothing here.
 *
 * WHAT IT MEASURED, 2026-09-28, on this machine (Linux x64, 28GB RAM shared
 * with other work; playwright 1.63; 87 docs, 1180KB of bodies, mean 13.6KB).
 * `live` and `peak` are the memory's ABSOLUTE size, since a tab's ceiling
 * bounds the whole instance; `base` is 1.2MB in every browser:
 *
 *     docs  bodies  snapshot     live     peak  per doc  build
 *       45   0.6MB     1.0MB    4.9MB    9.9MB     85KB     1s
 *       90   1.2MB     1.6MB    9.5MB   22.0MB     95KB     1s
 *      180   2.4MB     3.2MB   22.8MB   47.3MB    123KB   3-6s
 *      360   4.8MB     6.4MB   65.0MB  109.3MB    182KB    12s
 *      720   9.5MB    12.8MB  211.2MB  300.2MB    299KB  46-62s
 *     1440  19.1MB    25.9MB  751.1MB  957.2MB    533KB  230-365s
 *     2880  38.1MB    51.2MB   2809MB   3164MB    998KB    903s   (Chromium)
 *
 * Chromium 153 (full build) and Firefox 155 agree to the 0.1MB on every row
 * both ran, and both agree with the Node file's table to within ~1MB. That
 * is expected rather than suspicious: the memory is grown by Rust's
 * allocator INSIDE the WASM module, so the engine decides only the CEILING,
 * never the curve. Two consequences:
 *
 * 1. **No browser failed.** 2880 documents built and exported at a 3.2GB
 *    peak in Chromium — 79% of wasm32's 4GiB address space. 5760 was not
 *    run: at ~3.3x per doubling it would ask for well over 4GiB, and this
 *    host did not have the memory free to find out which refusal comes
 *    first. Firefox stopped at 1440 because the run was ended, not because
 *    it failed; WebKit (2359) was not measured.
 * 2. **Time runs out before memory does on a desktop.** Building 1440
 *    documents took four to six minutes and 2880 took fifteen, super-linear
 *    like the memory. A person never builds a workspace in one call, so
 *    this is the fixture's cost, not the keeper's — but it is the same
 *    super-linearity, measured on a second axis.
 *
 * The preflight on Chromium: a 32MB Loro text grew the captured memory by
 * 71.1MB, and `measureUserAgentSpecificMemory` saw +66.9MB for a second
 * one — so both readings see Loro, and the buffer one is used because it
 * is Loro's alone, synchronous, and present in every engine. The headless
 * shell refuses the API, and Firefox has none.
 *
 * WHAT IT CANNOT SHOW.
 * - A real phone. These are desktop engines on a desktop host; a mobile
 *   Chrome's renderer is killed by the OS well before wasm32's 4GiB, at a
 *   point that depends on the device and what else is running.
 * - iOS Safari. Its jetsam limit kills the WebContent process on memory
 *   pressure, and Playwright's WebKit on Linux is not that process.
 * - Other tabs, the app's own JS heap, the editor and the layout worker —
 *   this is the record alone, so a real tab reaches any ceiling sooner.
 * - Time. A count that builds but takes a minute is not measured as a limit
 *   here, though a user would call it one.
 */
import { globSync, readFileSync } from 'node:fs'
import { freemem } from 'node:os'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, firefox, webkit } from 'playwright'
import { createServer } from 'vite'
import wasm from 'vite-plugin-wasm'

const HERE = dirname(fileURLToPath(import.meta.url))
const DOCS = resolve(HERE, '..', '..', '..', 'docs')
const MB = 1024 * 1024
const PAGE_TIMEOUT_MS = 90 * 60_000
/**
 * A row is not started unless the HOST can hold what it may ask for: ~3.3x
 * the last peak (each doubling has cost that), capped at wasm32's 4GiB
 * address space plus 2GiB for the rest of the tab — past which the browser,
 * not the host, is what refuses. So a count this machine cannot hold is
 * reported as the host's limit rather than taken for the browser's, and the
 * machine's other work is not pushed into swap.
 */
const hostNeeds = (lastPeak) => Math.min(4 * lastPeak, 6 * 1024 * MB)
const COUNTS = [45, 90, 180, 360, 720, 1440, 2880, 5760, 11520, 23040]
// Full Chromium rather than the headless shell: the shell refuses
// measureUserAgentSpecificMemory with a SecurityError even when isolated.
const ENGINES = {
  chromium: () => chromium.launch({ channel: 'chromium' }),
  firefox: () => firefox.launch(),
  webkit: () => webkit.launch(),
}

// Code-unit order, as `loadDocsCorpus` sorts, so both measurements replicate
// the same documents in the same order.
const corpus = globSync('**/*.md', { cwd: DOCS })
  .sort((a, b) => (a < b ? -1 : 1))
  .map((file) => ({
    path: file.replace(/\.md$/, ''),
    body: readFileSync(resolve(DOCS, file), 'utf8'),
  }))
const corpusBytes = corpus.reduce((n, d) => n + Buffer.byteLength(d.body, 'utf8'), 0)

const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}
const HTML =
  '<!doctype html><script type="module" src="/measure-workspace-record-memory.page.mjs"></script>'

const server = await createServer({
  configFile: false,
  root: HERE,
  logLevel: 'error',
  // The app's own resolution of loro-crdt (see vite.config.ts): the
  // `bundler/` entry, whose WASM vite-plugin-wasm instantiates.
  resolve: { alias: { 'loro-crdt': 'loro-crdt/bundler' } },
  plugins: [
    wasm(),
    {
      name: 'measure-page',
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          if (req.url !== '/') return next()
          res.setHeader('content-type', 'text/html')
          for (const [k, v] of Object.entries(ISOLATION)) res.setHeader(k, v)
          res.end(HTML)
        })
      },
    },
  ],
  // Cross-origin isolation, for measureUserAgentSpecificMemory: on every
  // module, and on the page itself, which the middleware above serves.
  server: { port: 0, headers: ISOLATION },
})
await server.listen()
const url = server.resolvedUrls.local[0]

function captureWasmMemories() {
  globalThis.__wasmMemories = []
  const keep = (result) => {
    const instance = result.instance ?? result
    const memory = instance?.exports?.memory
    if (memory instanceof WebAssembly.Memory) globalThis.__wasmMemories.push(memory)
    return result
  }
  const { instantiate, instantiateStreaming } = WebAssembly
  WebAssembly.instantiate = (...args) => instantiate.apply(WebAssembly, args).then(keep)
  if (instantiateStreaming) {
    WebAssembly.instantiateStreaming = (...args) =>
      instantiateStreaming.apply(WebAssembly, args).then(keep)
  }
}

/** A fresh context and page with the module loaded; the caller closes it. */
async function openPage(browser) {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.setDefaultTimeout(PAGE_TIMEOUT_MS)
  await page.addInitScript(captureWasmMemories)
  await page.goto(url)
  await page.waitForFunction(() => globalThis.__recordMemory !== undefined)
  return { context, page }
}

/** Runs `fn` on a fresh page; a crash, a hang or a closed page is a result, not an exception. */
async function onFreshPage(browser, fn) {
  let context
  try {
    const opened = await openPage(browser)
    context = opened.context
    const crashed = new Promise((res) =>
      opened.page.once('crash', () => res({ ok: false, stage: 'tab', error: 'page crashed' })),
    )
    return await Promise.race([fn(opened.page), crashed])
  } catch (err) {
    return {
      ok: false,
      stage: 'tab',
      error: String(err?.message ?? err)
        .split('\n')[0]
        .slice(0, 200),
    }
  } finally {
    await context?.close().catch(() => {})
  }
}

const mb = (n) => `${(n / MB).toFixed(1).padStart(7)}MB`

async function runEngine(name) {
  let browser
  try {
    browser = await ENGINES[name]()
  } catch (err) {
    console.log(`${name}: did not launch — ${String(err.message).split('\n')[0]}`)
    return
  }
  console.log(`\n${name} ${browser.version()}`)
  const pre = await onFreshPage(browser, (page) =>
    page.evaluate(() => globalThis.__recordMemory.preflight()),
  )
  console.log(
    `preflight  32MB Loro text -> ${pre.memories} wasm memories, grew ${pre.grewMb?.map((g) => `${g.toFixed(1)}MB`).join(', ')}`,
  )
  console.log(`preflight  measureUserAgentSpecificMemory: ${pre.uaSpecific}`)
  if (!(pre.found >= 0) || pre.witness !== 32 * MB) {
    console.error(
      `FAIL: ${name} shows no 32MB allocation in any wasm memory; every row would lie`,
      pre,
    )
    await browser.close()
    process.exitCode = 1
    return
  }

  console.log('  docs   bodies   snapshot       base       live       peak   per doc')
  let lastPeak = 0
  for (const count of COUNTS) {
    if (freemem() < hostNeeds(lastPeak)) {
      console.log(
        `  ${String(count).padStart(5)}   NOT RUN: host has ${mb(freemem()).trim()} available, under the ${mb(hostNeeds(lastPeak)).trim()} it may need`,
      )
      break
    }
    const started = Date.now()
    const row = await onFreshPage(browser, (page) =>
      page.evaluate(
        ([c, n, i]) => globalThis.__recordMemory.measure(c, n, i),
        [corpus, count, pre.found],
      ),
    )
    const secs = ((Date.now() - started) / 1000).toFixed(0)
    if (!row.ok) {
      const reached =
        row.reached === undefined
          ? ''
          : ` at document ${row.built}, memory ${mb(row.reached).trim()}`
      console.log(
        `  ${String(count).padStart(5)}   FAILED in ${row.stage}${reached} after ${secs}s: ${row.error}`,
      )
      break
    }
    console.log(
      `  ${String(count).padStart(5)} ${mb((corpusBytes * count) / corpus.length)} ${mb(row.snapshot)} ` +
        `${mb(row.base)} ${mb(row.live)} ${mb(row.peak)} ${(((row.live - row.base) / count) * (1024 / MB)).toFixed(0).padStart(6)}KB   (${secs}s)`,
    )
    lastPeak = row.peak
  }
  await browser.close()
}

console.log(
  `corpus     ${corpus.length} documents from ${relative(process.cwd(), DOCS)}, ${(corpusBytes / 1024).toFixed(0)}KB of bodies`,
)
console.log("each row is its OWN page, so its high-water mark is that count's footprint")
try {
  const requested = process.argv.slice(2)
  for (const name of requested.length > 0 ? requested : Object.keys(ENGINES)) await runEngine(name)
} finally {
  await server.close()
}
