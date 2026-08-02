#!/usr/bin/env node

// Test double for `pnpm mcp:http:dev`, invoked by ensure-http-dev-daemon.mjs
// via a PATH-shimmed `pnpm` wrapper (see ensure-http-dev-daemon.script.test.ts).
// Simulates a dev daemon's build-then-bind startup shape without paying for
// a real tsx/canvas/resvg cold start, so the wait-path and timeout-path
// tests run in well under the mcp-node project's 10s testTimeout.
//
// Behavior is entirely env-driven so the test controls timing without
// touching argv (which the real pnpm script also receives --port=/--token=
// for):
//   FAKE_PNPM_INVOKED_SENTINEL     - path written immediately on
//     invocation, so a test can assert this process was (or was not) ever
//     spawned.
//   FAKE_PNPM_INVOKED_SENTINEL_DIR - directory that gets one uniquely
//     named JSON file per invocation, so a concurrency test can COUNT how
//     many times `pnpm mcp:http:dev` was actually spawned (the single-file
//     sentinel above can only tell you "at least once").
//   FAKE_PNPM_BIND_DELAY_MS        - ms to sleep before binding (default 0).
//   FAKE_PNPM_NEVER_BIND           - when set, sleeps indefinitely instead
//     of ever calling startFakeMcpResponder, simulating a daemon stuck
//     before its listen() call.
//   FAKE_PNPM_BIND_SENTINEL        - path written the moment the responder
//     starts listening, carrying a boundAt timestamp the test compares
//     against the hook's own exit time (happens-before assertion).
//   FAKE_PNPM_MARKER_JSON          - when set, its value is written to the
//     data dir's dev-daemon.json at bind time, letting a test drive the
//     post-spawn identity-mismatch branch to a foreign verdict.

import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startFakeMcpResponder } from './fake-mcp-daemon.mjs'

const PORT_FLAG = '--port='
const TOKEN_FLAG = '--token='
const args = process.argv.slice(2)
const port = Number(args.find((arg) => arg.startsWith(PORT_FLAG))?.slice(PORT_FLAG.length))
const token =
  args.find((arg) => arg.startsWith(TOKEN_FLAG))?.slice(TOKEN_FLAG.length) ?? 'whiteboard-dev'

const invokedSentinel = process.env.FAKE_PNPM_INVOKED_SENTINEL
if (invokedSentinel) {
  writeFileSync(invokedSentinel, JSON.stringify({ pid: process.pid, invokedAt: Date.now() }))
}

const invokedSentinelDir = process.env.FAKE_PNPM_INVOKED_SENTINEL_DIR
if (invokedSentinelDir) {
  mkdirSync(invokedSentinelDir, { recursive: true })
  writeFileSync(
    join(invokedSentinelDir, `${process.pid}-${randomUUID()}.json`),
    JSON.stringify({ pid: process.pid, invokedAt: Date.now() }),
  )
}

const bindDelayMs = Number(process.env.FAKE_PNPM_BIND_DELAY_MS ?? '0')
await new Promise((resolveSleep) => setTimeout(resolveSleep, bindDelayMs))

if (process.env.FAKE_PNPM_NEVER_BIND === '1') {
  // Never resolves: this process just sits here, like a dev server stuck
  // before its listen() call. The test kills it directly during cleanup.
  await new Promise(() => {})
}

await startFakeMcpResponder({ port, token })

const markerJson = process.env.FAKE_PNPM_MARKER_JSON
const dataDir = process.env.WHITEBOARD_DATA_DIR
if (markerJson && dataDir) {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'dev-daemon.json'), markerJson)
}

const bindSentinel = process.env.FAKE_PNPM_BIND_SENTINEL
if (bindSentinel) {
  writeFileSync(bindSentinel, JSON.stringify({ boundAt: Date.now() }))
}

// Stay alive like a real `tsx watch` dev process; the test kills this pid
// directly during cleanup instead of expecting a graceful shutdown path.
await new Promise(() => {})
