#!/usr/bin/env node

// Test double for `pnpm mcp:http:dev`, invoked by ensure-http-dev-daemon.mjs
// via a PATH-shimmed `pnpm` wrapper (see ensure-http-dev-daemon.script.test.ts).
// Simulates a dev daemon's build-then-bind startup shape without paying for
// a real tsx/canvas/resvg cold start, so the wait-path and timeout-path
// tests run in well under the mcp-node project's 10s testTimeout.
//
// Behavior is entirely env-driven so the test controls timing without
// touching argv (which the real pnpm script also receives --token= for):
//   FAKE_PNPM_INVOKED_SENTINEL     - path written immediately on
//     invocation, so a test can assert this process was (or was not) ever
//     spawned.
//   FAKE_PNPM_INVOKED_SENTINEL_DIR - directory that gets one uniquely
//     named JSON file per invocation, so a concurrency test can COUNT how
//     many times `pnpm mcp:http:dev` was actually spawned (the single-file
//     sentinel above can only tell you "at least once").
//   FAKE_PNPM_BIND_DELAY_MS        - ms to sleep before binding (default 0).
//   FAKE_PNPM_BIND_FAILS           - when set, throws EADDRINUSE from the
//     same path a real bind failure takes, so a test does not have to win a
//     race against the OS to produce one.
//   FAKE_PNPM_NEVER_BIND           - when set, sleeps indefinitely instead
//     of ever calling startFakeMcpResponder, simulating a daemon stuck
//     before its listen() call.
//   FAKE_PNPM_BIND_SENTINEL        - path written the moment the responder
//     starts listening, carrying a boundAt timestamp the test compares
//     against the hook's own exit time (happens-before assertion).
//
// Like the real daemon, it listens on a socket and then writes daemon.json
// naming that socket into WHITEBOARD_DATA_DIR — or, when that is unset, into
// `<checkout>/.dev-data` of the checkout it was started in, as the wrapper
// behind the real `pnpm mcp:http:dev` resolves it.

import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveRepoRootFromGit } from '../with-dev-data-dir-lib.mjs'
import { startFakeMcpResponder } from './fake-mcp-daemon.mjs'

const TOKEN_FLAG = '--token='
const args = process.argv.slice(2)
const token =
  args.find((arg) => arg.startsWith(TOKEN_FLAG))?.slice(TOKEN_FLAG.length) ?? 'whiteboard-dev'

// Without an override the real wrapper serves the checkout it is started in,
// so this does too: which checkout the hook started it in is then observable.
const dataDir =
  process.env.WHITEBOARD_DATA_DIR || join(resolveRepoRootFromGit(process.cwd()), '.dev-data')
mkdirSync(dataDir, { recursive: true })
const socketPath = join(dataDir, 'fake-daemon.sock')

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

try {
  if (process.env.FAKE_PNPM_BIND_FAILS === '1') {
    // Injected rather than manufactured. Proving that a bind failure is
    // reported is about THIS process failing and the hook saying so; making
    // it happen for real meant racing a squatter into the window between
    // the hook's probe and the listen() below, and under load the race is
    // lost in the direction that looks like a product bug — the server
    // starts, the hook reports success, and the assertion complains that a
    // log path is missing.
    throw Object.assign(new Error(`listen EADDRINUSE: address already in use ${socketPath}`), {
      code: 'EADDRINUSE',
    })
  }
  await startFakeMcpResponder({ socketPath, token })
} catch (err) {
  // Without this the rejection is unhandled: the process dies with exit 1
  // and NOTHING on stderr, so the hook can only report "spawned process
  // exited with code 1" and the log it points at is empty. Say why.
  process.stderr.write(
    `[fake-pnpm-shim] failed to listen: ${err?.code ?? ''} ${err?.message ?? err}\n`,
  )
  process.exit(1)
}

writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid: process.pid, token, socketPath }))

const bindSentinel = process.env.FAKE_PNPM_BIND_SENTINEL
if (bindSentinel) {
  writeFileSync(bindSentinel, JSON.stringify({ boundAt: Date.now() }))
}

// Stay alive like a real `tsx watch` dev process; the test kills this pid
// directly during cleanup instead of expecting a graceful shutdown path.
await new Promise(() => {})
