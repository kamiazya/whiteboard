#!/usr/bin/env node
import { existsSync } from 'node:fs'
// The INSTRUMENT for what the byte budget is a proxy for.
//
// `smoke-bundle-size.mjs` counts gzipped bytes on the critical path. That is
// cheap and perfectly repeatable, and it is not what anyone cares about: it is
// a stand-in for how long a fresh visitor waits. A stand-in can drift from
// what it stands for with every individually justified raise, which is how a
// budget stops meaning anything.
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
// - `longTasks`  Total milliseconds in tasks over 50ms, counted from
//   navigation start (a buffered `longtask` observer, so work before first
//   paint is included) until the run is read. NOT Total Blocking Time: TBT
//   starts at FCP, subtracts 50ms per task and bounds at TTI. Called what it is
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
// moved LCP from 512 to 600 ms (+88 ms) with the spread unchanged at 2% — signal
// about nine times the noise band. At 4.9 ms per gzipped KB, an LCP gate that
// respects that band detects a regression of roughly **2.5 KB gzipped**. It
// would NOT have caught a +335 byte change; that is 1.6 ms, inside the noise.
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
// ## What drives it: requests, not bytes (re-measured 2026-10-14)
//
// The 4.9 ms per KB above held while the critical path was a handful of
// files, and it stopped describing CI as the file count grew. CI medians on
// main (verify job, 5 runs each): 516-548 ms on 2026-09-02 at 23 files,
// 592-600 ms on 10-01 at 28 files and 141.3 KB, 840-900 ms on 10-05 at 36
// files and 148.5 KB, 772-944 ms over 60 runs 10-12..10-14 at 38 files and
// 151.6 KB — one of them a FAILED floor at 1116 ms whose own fastest run was
// 724. Bytes predicted about +50 ms over that span; LCP rose about +280.
//
// The local A/B that separates the two (this container under load, 5 runs a
// set, two or three sets each, medians):
//
//   main as it was     38 files  151.6 KB    872-1012 ms
//   bytes cut only     38 files  143.8 KB    912 ms
//   files cut too       9 files  136.1 KB    516-608 ms
//
// Taking 7.8 KB off moved nothing measurable; collapsing 38 preloads into 9
// took about a third off. The likely mechanism is the rig itself: it serves
// HTTP/1.1, where Chrome opens at most six connections to an origin, so 38
// modulepreloads queue in rounds of the emulated 40 ms latency. How much of
// that a visitor on the deployed origin's HTTP/2 pays is not measured.
// That is why `smoke-bundle-size.mjs` budgets the critical path's FILE COUNT
// beside its bytes — the byte budget cannot see a request, and the count is
// deterministic where this is not.
//
// ## The floor (decision 2026-08-30)
//
// `LCP_FLOOR_MS=1000` gates CI, stated as "a mid-range phone on a decent
// connection sees the shell inside a second, whatever the code does". It was
// set at roughly twice a 492 ms median, to catch only a serious accident.
// Measured locally now at 516-608 ms for 9 files, it is back near that
// distance; at 38 files CI ran within 6-20% of it on a per-run spread of
// 10-130%, which is how a required gate goes red on noise. A floor red whose
// own fastest run is far under the floor is that noise; one whose fastest run
// is over it is not.
//
// It is still not a second byte budget. Set close to the measurement it would
// resolve about 2.5 KB against `smoke-bundle-size.mjs`'s few hundred bytes,
// with a noise band the byte count does not have. So the jobs stay split:
// the byte and file budgets DETECT CHANGE, this states an ABSOLUTE FLOOR.
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
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { isRunAsScript } from '../../../tools/checks/src/is-run-as-script.mjs'
import { serveDist } from '../../../tools/checks/src/serve-dist.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = resolve(ROOT, 'dist')

const RUNS = Number(process.env.MEASURE_RUNS ?? 10)
// Set by the GATE caller only. Absent, this script reports and fails nothing,
// which is what it was built to be; the assertion belongs to whoever states a
// floor, not to the instrument.
//
// A value that is PRESENT but not a positive finite number is refused rather
// than tolerated, because tolerating it fails in the direction that reads as
// success: `Number('1000ms')` is NaN, `NaN === null` is false so the gate
// arms, and `median > NaN` is false so every run passes. A typo in the env
// var would disable enforcement while the job stayed green — measured, and it
// prints `LCP floor: OK ... floor NaNms`. That is the same
// guard-that-never-reaches-its-subject shape the mount check below refuses,
// one level up in the gate's own configuration.
//
// Pure and exported so both directions are testable without a browser: the
// caller does the exiting.
export function parseFloorMs(raw) {
  if (raw === undefined || raw === '') return { floor: null }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return {
      error:
        `LCP_FLOOR_MS must be a positive number of milliseconds; got ${JSON.stringify(raw)}.` +
        ' Refusing to run, because an unparseable floor would arm the gate and pass everything.',
    }
  }
  return { floor: parsed }
}
// The fixed settle after `load`, and the bounded grace that only a run which
// LOSES that bet ever pays.
//
// The fixed beat is a bet on how long the app takes to mount, and a cold
// first run loses it. Measured on CI: run 1 of 5 came back `mounted=false`,
// and the gate did exactly what it should — a number taken over the boot
// splash is not the shell's LCP, so it refused. The run was not wrong about
// what it saw; the instrument had not waited long enough for there to be
// anything else to see. That is a flake in the INSTRUMENT, and re-running it
// is how a gate starts being ignored.
//
// The grace is deliberately not "wait longer". Raising the fixed beat would
// widen the LCP observation window on every run, including the healthy ones,
// and every median in the comment block above was taken through the 2000ms
// window — the floor would then be stated against one measurement and
// enforced against another. So the beat is untouched and the extra wait is
// reached only when the first probe comes back unmounted: a healthy run's
// timeline is byte-identical to what it was, and a slow run reports the LCP
// it actually had instead of failing the gate over the splash.
//
// It stays BOUNDED and the probe still has the last word. An app that truly
// never mounts must still fail, and fail with the gate's own diagnosis rather
// than a Playwright timeout, which is why the expiry is swallowed here.
//
// Verified against a real browser by shortening the beat to 1ms, which
// reproduces the lost bet on demand instead of waiting for a cold CI runner:
//
//   beat 1ms, no grace     3/3 never mounted, gate FAILED (exit 1)
//   beat 1ms, grace 8s     3/3 mounted, grace 1931-1970ms, LCP median 504 ms
//   beat 2000ms (healthy)  5/5 mounted, no grace paid,     LCP median 500 ms
//   beat 1ms, grace 200ms  2/2 never mounted, gate FAILED (exit 1)
//
// The middle two rows are the claim that matters and the reason the beat is
// left alone: a run that pays the grace reports the same LCP as one that does
// not, inside the 2% band. The last row is the one that keeps this honest —
// a grace long enough to rescue a slow run must still be short enough that a
// build which never mounts is refused, with the message above rather than a
// selector timeout.
const SETTLE_MS = Number(process.env.MEASURE_SETTLE_MS ?? 2000)
const MOUNT_GRACE_MS = Number(process.env.MEASURE_MOUNT_GRACE_MS ?? 8000)

// Injected rather than closed over a `page`, so both branches are testable
// without a browser — the same reason `parseFloorMs` is pure and exported.
export async function settleForMount({ waitFixed, probe, waitForMount, now = Date.now }) {
  await waitFixed()
  const first = await probe()
  if (first.shellMark) return { ...first, graceMs: 0 }
  const started = now()
  try {
    await waitForMount()
  } catch {
    // Expiry is not the verdict. The probe below is.
  }
  return { ...(await probe()), graceMs: now() - started }
}

// A mid-range phone on a decent connection, fixed so two runs are comparable.
// The absolute numbers are only meaningful against each other.
const CPU_THROTTLE = Number(process.env.MEASURE_CPU_THROTTLE ?? 4)
const NETWORK = {
  offline: false,
  latency: 40,
  downloadThroughput: (10 * 1024 * 1024) / 8,
  uploadThroughput: (3 * 1024 * 1024) / 8,
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
  const mounted = await settleForMount({
    // The app dismisses its boot splash and mounts React after load; settle
    // for a fixed beat so LCP has landed on real content rather than on the
    // splash. This is the window every recorded median was taken through.
    waitFixed: () => page.waitForTimeout(SETTLE_MS),
    // Did the APP render, or did this measure the boot splash?
    //
    // Not decoration. The first run of this script reported LCP identical to
    // FCP in every single run, which is what a page whose largest paint is
    // its own splash looks like — and also what a page that never mounted
    // looks like. A 2% spread on a number that describes the wrong thing
    // reads as "gateable" and is worse than no measurement. So the instrument
    // states what it saw rather than leaving the reader to assume.
    probe: () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-testid="shell-mark"]')
        const root = document.getElementById('root')
        return {
          shellMark: el !== null,
          rootChildren: root ? root.childElementCount : 0,
          largestText: document.body.innerText.slice(0, 60).replace(/\s+/g, ' ').trim(),
        }
      }),
    waitForMount: () =>
      page.waitForSelector('[data-testid="shell-mark"]', { timeout: MOUNT_GRACE_MS }),
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
  // First, so a misconfigured gate costs nothing and cannot be mistaken for a
  // measurement that ran.
  const floor = parseFloorMs(process.env.LCP_FLOOR_MS)
  if (floor.error !== undefined) {
    console.error(floor.error)
    process.exit(1)
  }
  const FLOOR_MS = floor.floor

  if (!existsSync(join(DIST, 'index.html'))) {
    console.error(
      'dist/index.html not found — run `pnpm --filter @kamiazya/whiteboard-web build` first',
    )
    process.exit(1)
  }
  // No caching, so every run pays the full download the way a first visitor
  // does. A warm cache would measure the wrong visit.
  const app = await serveDist({ root: DIST, headers: { 'Cache-Control': 'no-store' } })
  const url = `${app.origin}/`
  // `WHITEBOARD_CHROME_PATH` when the environment supplies its own Chrome,
  // exactly as `smoke-preview-origin.mjs` does. CI's `verify` job installs no
  // Playwright browsers — it sets that variable to the system Chrome — so a
  // bare launch there fails with "Executable doesn't exist", which is a
  // missing browser and not a slow one. Measured: that is how this gate first
  // failed on CI, having passed every local run.
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.WHITEBOARD_CHROME_PATH && {
      executablePath: process.env.WHITEBOARD_CHROME_PATH,
    }),
  })
  const runs = []
  try {
    for (let i = 0; i < RUNS; i++) {
      const m = await measureOnce(browser, url)
      runs.push(m)
      process.stderr.write(
        `run ${i + 1}/${RUNS}  lcp=${m.lcp.toFixed(0)}ms  fcp=${m.fcp.toFixed(0)}ms  longTasks=${m.longTasks.toFixed(0)}ms  cls=${m.cls.toFixed(4)}  mounted=${m.shellMark} rootKids=${m.rootChildren}${m.graceMs > 0 ? ` grace=${m.graceMs}ms` : ''} text="${m.largestText}"\n`,
      )
    }
  } finally {
    await browser.close()
    await app.close()
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

// Importable for its own tests; runs only when executed directly, exactly as
// `smoke-bundle-size.mjs` does.
if (isRunAsScript(import.meta.url)) {
  await main()
}
