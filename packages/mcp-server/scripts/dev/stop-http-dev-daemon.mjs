#!/usr/bin/env node
// `pnpm mcp:http:stop`: stop this checkout's dev daemon (see
// stop-http-dev-daemon-lib.mjs). Reads the same data dir `pnpm mcp:http:dev`
// uses — `<repo>/.dev-data`, or WHITEBOARD_DATA_DIR when that is set.
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseScriptArgs } from '../../../../.claude/scripts/script-flags.mjs'
import { readDaemonRecord } from './dev-daemon-socket-lib.mjs'
import { stopDevDaemon } from './stop-http-dev-daemon-lib.mjs'
import {
  devWrapperPidPath,
  resolveDevDataDirEnv,
  resolveRepoRootFromGit,
} from './with-dev-data-dir-lib.mjs'

// Parsed before anything is read or signalled: an unrecognised flag is a refusal, not consent.
parseScriptArgs({
  argv: process.argv.slice(2),
  usage: "usage: stop-http-dev-daemon.mjs  (takes no options; stops this checkout's dev daemon)",
})

const dataDir = resolveDevDataDirEnv(
  process.env,
  resolveRepoRootFromGit(process.cwd()),
).WHITEBOARD_DATA_DIR

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, and is not ours to signal.
    return error?.code === 'EPERM'
  }
}

function readWrapperPid(dir) {
  try {
    const pid = Number(readFileSync(devWrapperPidPath(dir), 'utf8'))
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

const result = await stopDevDaemon({
  dataDir,
  readRecord: readDaemonRecord,
  readWrapperPid,
  isAlive,
  kill: (pid, signal) => process.kill(pid, signal),
  sleep,
})

if (result.kind === 'none') {
  console.log(`no dev daemon is running for ${dataDir}`)
} else if (result.kind === 'stopped') {
  console.log(
    `stopped the dev daemon for ${dataDir} (signalled the ${result.via}, pid ${result.pid})`,
  )
} else {
  console.error(`pid ${result.pid} was signalled but is still running for ${dataDir}`)
  process.exit(1)
}
