#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs'
// The INSTRUMENT for what the byte budget is a proxy for.
//
// `smoke-bundle-size.mjs` counts gzipped bytes on the critical path. That is
// cheap and perfectly repeatable, and it is not what anyone cares about: it is
// a stand-in for how long a fresh visitor waits. The stand-in has drifted —
// 108 -> 114 -> 126 -> 138 KB in four raises, each individually justified,
// which is how a budget stops meaning anything — and the file says so itself.
//
// Before replacing that budget with a gate on measured metrics, the thing to
// establish is whether such a gate can be TRUSTED, which is a question about
// VARIANCE and not about which metric is nicer. A gate whose spread exceeds
// the regression it is meant to catch goes red, gets re-run, and then gets
// ignored — the same decay, one layer up. So this script measures and reports
// spread; it deliberately asserts nothing and fails nothing.
//
// What it measures, and what each name honestly means:
//
// - `lcp`     Largest Contentful Paint, from the browser's own entry.
// - `fcp`     First Contentful Paint, likewise.
// - `cls`     Cumulative Layout Shift, summed over non-input-driven shifts.
// - `longTasksMs`  Total time in tasks over 50ms after FCP. NOT Total Blocking
//   Time: TBT subtracts 50ms per task and bounds at TTI. Called what it is
//   rather than borrowed, because a number labelled TBT would be compared
//   against Lighthouse's and they are not the same quantity.
//
// Throttling is OBSERVED (CDP CPU rate + network conditions), not simulated.
// Lighthouse's lantern model computes from a trace and is far steadier; the
// point of measuring here first is to find out how much steadiness observed
// throttling costs on this machine, with tooling the repo already has.
//
// ## What it measured (this container, 2026-08-29, 10 runs at CPU x4)
//
//   LCP / FCP     512 ms median, 504-516        spread  2%
//   long tasks    611 ms median, 548-682        spread 22%
//   CLS           0.0000                        spread  0%
//
// Two facts decide what a gate on these can be, and neither is guessable:
//
// **The instrument responds.** Appending 17.9 KB gzipped to the entry chunk
// moved LCP 512 -> 600 ms (+88 ms) with the spread unchanged at 2% — signal
// about nine times the noise band. At 4.9 ms per gzipped KB, an LCP gate that
// respects that band detects a regression of roughly **2.5 KB gzipped**. It
// would NOT have caught the +335 bytes that occasioned the last budget raise;
// that is 1.6 ms, inside the noise.
//
// **LCP is the steady one and long tasks is not.** The CPU-bound metric —
// the one that would catch a parse/execute regression the transfer number
// misses — carries a 13-22% spread here, on a quiet machine. Signal and noise
// are the same size, so it cannot gate anything.
//
// Both numbers describe THIS container. A CI runner is noisier, and the
// honest expectation differs per metric: LCP here is dominated by
// CDP-emulated transfer, which is wall-clock-independent to first order and
// so has a real chance of staying steady; long tasks is raw CPU and will not.
//
// LCP == FCP in every run, and that is genuine rather than a measurement that
// missed: the app's largest paint IS its first, because the shell is all
// there is before the lazy page arrives. The mount check below is what
// establishes that — it was added after the first run, where a 2% spread on
// an unverified number read as "gateable".
//
// ## The floor, and why it is deliberately far away (decision 2026-08-30)
//
// `LCP_FLOOR_MS=1000` gates CI. Current median is 492 ms, so the floor sits at
// roughly twice the measurement and catches only a serious accident — about
// 100 KB gzipped of new critical path. That distance is the POINT, not slack
// left over from picking a round number.
//
// The reason is what this rig actually measures. LCP here is dominated by
// CDP-emulated transfer, and the response is linear at **4.9 ms per gzipped
// KB** — so on this machine LCP is very nearly a function of bytes. Set close
// to the measurement and it becomes a second byte budget, with 2.5 KB of
// resolution against `smoke-bundle-size.mjs`'s 335 bytes, plus a noise band
// the byte count does not have. Seven times coarser and less certain, for the
// same question, is not a gate worth having.
//
// So the two are given different jobs rather than different numbers:
// bytes DETECT CHANGE, this states an ABSOLUTE FLOOR — "a mid-range phone on
// a decent connection sees the shell inside a second, whatever the code does".
// A regression small enough to matter reaches the byte budget first, by
// design; anything that reaches this one has gone badly wrong.
//
// What would make LCP an independent signal is the CPU-bound half — the
// parse/execute cost bytes cannot see. `longTasks` is that quantity and it
// carries a 14-70% spread here, measured twice: signal and noise are the same
// size, so it gates nothing. Getting that half honestly needs a steadier
// measurement (Lighthouse's lantern model, or real field data), which is a
// separate piece of work and not a threshold choice.
//
// One measured caveat shaped the gate's mechanics rather than its number: a
// COLD first run reads high. Two 10-run sets on the same build gave medians
// of 492 ms both times, but the first set's opening run was 548 ms (+11%) and
// the second set had no outlier at all. A single-shot gate would therefore
// flake on an effect that has nothing to do with the code, which is why this
// gates the MEDIAN of several runs and never one.
import { createServer } from 'node:http'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = resolve(ROOT, 'dist')

const RUNS = Number(process.env.MEASURE_RUNS ?? 10)
// Set by the GATE caller only. Absent, this script reports and fails nothing,
// which is what it was built to be; the assertion belongs to whoever states a
// floor, not to the instrument.
const FLOOR_MS = process.env.LCP_FLOOR_MS === undefined ? null : Number(process.env.LCP_FLOOR_MS)
// A mid-range phone on a decent connection, fixed so two runs are comparable.
// The absolute numbers are only meaningful against each other.
const CPU_THROTTLE = Number(process.env.MEASURE_CPU_THROTTLE ?? 4)
const NETWORK = {
  offline: false,
  latency: 40,
  downloadThroughput: (10 * 1024 * 1024) / 8,
  uploadThroughput: (3 * 1024 * 1024) / 8,
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

function serveDist() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let file = join(DIST, decodeURIComponent(url.pathname))
    // SPA fallback: every non-asset path is the app's own route to interpret,
    // which is the whole point of the address grammar this app uses.
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html')
    const body = readFileSync(file)
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      // No caching, so every run pays the full download the way a first
      // visitor does. A warm cache would measure the wrong visit.
      'Cache-Control': 'no-store',
    })
    res.end(body)
  })
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port }))
  })
}

// Installed BEFORE any document script runs: LCP and layout-shift entries are
// emitted during load, and an observer registered afterwards sees none of them
// — which reads as a perfect score rather than as a measurement that missed.
const COLLECTOR = `
  window.__m = { lcp: 0, cls: 0, longTasks: 0, fcp: 0 }
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) window.__m.lcp = e.startTime
  }).observe({ type: 'largest-contentful-paint', buffered: true })
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) if (!e.hadRecentInput) window.__m.cls += e.value
  }).observe({ type: 'layout-shift', buffered: true })
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) if (e.duration > 50) window.__m.longTasks += e.duration
  }).observe({ type: 'longtask', buffered: true })
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__m.fcp = e.startTime
  }).observe({ type: 'paint', buffered: true })
`

async function measureOnce(browser, url) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.addInitScript(COLLECTOR)
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', NETWORK)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE })
  await page.goto(url, { waitUntil: 'load' })
  // The app dismisses its boot splash and mounts React after load; settle for
  // a fixed beat so LCP has landed on real content rather than on the splash.
  await page.waitForTimeout(2000)
  // Did the APP render, or did this measure the boot splash?
  //
  // Not decoration. The first run of this script reported LCP identical to
  // FCP in every single run, which is what a page whose largest paint is its
  // own splash looks like — and also what a page that never mounted looks
  // like. A 2% spread on a number that describes the wrong thing reads as
  // "gateable" and is worse than no measurement. So the instrument states
  // what it saw rather than leaving the reader to assume.
  const mounted = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="shell-mark"]')
    const root = document.getElementById('root')
    return {
      shellMark: el !== null,
      rootChildren: root ? root.childElementCount : 0,
      largestText: document.body.innerText.slice(0, 60).replace(/\s+/g, ' ').trim(),
    }
  })
  const m = await page.evaluate(() => window.__m)
  await context.close()
  return { ...m, ...mounted }
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const min = sorted[0]
  const max = sorted[sorted.length - 1]
  // Spread as a fraction of the median: the number that decides whether a
  // threshold can sit close to the measurement or has to sit far from it.
  const spread = median === 0 ? 0 : (max - min) / median
  return { median, min, max, spread }
}

function row(name, s, unit) {
  const f = (n) => (unit === 'ms' ? n.toFixed(0) : n.toFixed(4))
  return `${name.padEnd(14)} median ${f(s.median).padStart(7)} ${unit}   min ${f(s.min).padStart(7)}   max ${f(s.max).padStart(7)}   spread ${(s.spread * 100).toFixed(0)}%`
}

async function main() {
  if (!existsSync(join(DIST, 'index.html'))) {
    console.error(
      'dist/index.html not found — run `pnpm --filter @kamiazya/whiteboard-web build` first',
    )
    process.exit(1)
  }
  const { server, port } = await serveDist()
  const url = `http://127.0.0.1:${port}/`
  const browser = await chromium.launch()
  const runs = []
  try {
    for (let i = 0; i < RUNS; i++) {
      const m = await measureOnce(browser, url)
      runs.push(m)
      process.stderr.write(
        `run ${i + 1}/${RUNS}  lcp=${m.lcp.toFixed(0)}ms  fcp=${m.fcp.toFixed(0)}ms  longTasks=${m.longTasks.toFixed(0)}ms  cls=${m.cls.toFixed(4)}  mounted=${m.shellMark} rootKids=${m.rootChildren} text="${m.largestText}"\n`,
      )
    }
  } finally {
    await browser.close()
    server.close()
  }

  console.log(`\ncritical-path measurement — ${RUNS} runs, CPU x${CPU_THROTTLE}, 10Mbps/40ms`)
  console.log(row('LCP', stats(runs.map((r) => r.lcp)), 'ms'))
  console.log(row('FCP', stats(runs.map((r) => r.fcp)), 'ms'))
  console.log(row('long tasks', stats(runs.map((r) => r.longTasks)), 'ms'))
  console.log(row('CLS', stats(runs.map((r) => r.cls)), ''))

  if (FLOOR_MS === null) return

  // The mount check is part of the GATE, not decoration, and the numbers say
  // so. Measured by replacing the entry chunk with a no-op, so the app never
  // mounts and only the boot splash paints: LCP 460ms, against 492ms working.
  // A broken build is FASTER, so a floor on its own would read it as an
  // improvement and pass. This is the one way this gate can be satisfied while
  // measuring nothing.
  //
  // Both halves are needed and only one of them fires: that same run reported
  // `rootChildren=1`, because the splash is itself a child — so the child
  // count alone would have missed it, and `shellMark` is what refuses it.
  const unmounted = runs.filter((r) => !r.shellMark || r.rootChildren === 0)
  if (unmounted.length > 0) {
    console.error(
      `\nLCP floor: FAILED — ${unmounted.length}/${runs.length} runs never mounted the app.` +
        ' The number above describes the boot splash, not the shell.',
    )
    process.exitCode = 1
    return
  }

  const lcp = stats(runs.map((r) => r.lcp))
  if (lcp.median > FLOOR_MS) {
    console.error(
      `\nLCP floor: FAILED — median ${lcp.median.toFixed(0)}ms is over the ${FLOOR_MS}ms floor.`,
    )
    process.exitCode = 1
    return
  }
  console.log(`\nLCP floor: OK — median ${lcp.median.toFixed(0)}ms, floor ${FLOOR_MS}ms`)
}

await main()
