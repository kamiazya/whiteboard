// The eval removes its scratch directory as it exits, and every child it
// tracks writes into that directory. A child still running at the removal
// writes the data dir back, so stopping one is only done once it is gone.
import { type ChildProcess, spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { stopLiveChildren, trackChild } from './live-children.mjs'

/** A server that ignores the close the eval asks for, and a SIGTERM too. */
function stubbornChild() {
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { stdio: 'ignore' },
  )
  const forget = trackChild({ close: () => new Promise<void>(() => {}), pid: () => child.pid })
  return { child, forget }
}

/**
 * A server that ends when asked: its close SIGTERMs it and waits for the exit,
 * as an MCP client's close ends the stdio server it started.
 */
function cooperativeChild() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  const forget = trackChild({
    close: async () => {
      child.kill('SIGTERM')
      await exited
    },
    pid: () => child.pid,
  })
  return { child, forget }
}

const started: { child: ChildProcess; forget: () => void }[] = []
afterEach(() => {
  for (const { child, forget } of started.splice(0)) {
    forget()
    child.kill('SIGKILL')
  }
})

describe('stopLiveChildren', () => {
  it('resolves only once a child that ignored its close has ended', async () => {
    const stubborn = stubbornChild()
    started.push(stubborn)
    await new Promise((resolve) => stubborn.child.once('spawn', resolve))

    await stopLiveChildren(50)

    expect(stubborn.child.signalCode).toBe('SIGKILL')
  })

  // The `claude` child stops the MCP server it runs only when it is closed;
  // a SIGKILL first would orphan that grandchild in the scratch directory.
  it('ends a child that honours its close by the close, not by a kill', async () => {
    const cooperative = cooperativeChild()
    started.push(cooperative)
    await new Promise((resolve) => cooperative.child.once('spawn', resolve))

    await stopLiveChildren(5_000)

    expect(cooperative.child.signalCode).toBe('SIGTERM')
  })
})

describe('exitOnSignal', () => {
  // The eval's top level awaits a client's connect; a signal closes that
  // client under it, and the rejection that follows reaches the top level.
  // The run must still end as the interrupt it was, not as that failure.
  it('exits with its code even when the interrupted work then rejects', async () => {
    const lib = new URL('./live-children.mjs', import.meta.url).href
    const script = [
      `import { exitOnSignal } from ${JSON.stringify(lib)}`,
      // As stopLiveChildren does, the stop outlasts the rejection it causes.
      'exitOnSignal(130, () => new Promise((resolve) => setTimeout(resolve, 300)))',
      "process.kill(process.pid, 'SIGTERM')",
      "await new Promise((_, reject) => setTimeout(() => reject(new Error('Not connected')), 20))",
      'await new Promise((resolve) => setTimeout(resolve, 5_000))',
    ].join('\n')
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: 'ignore',
    })
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve))

    expect(code).toBe(130)
  })

  it('exits with its code at a second signal while the stop never ends', async () => {
    const lib = new URL('./live-children.mjs', import.meta.url).href
    const script = [
      `import { exitOnSignal } from ${JSON.stringify(lib)}`,
      // The second signal arrives while the first one's stop is pending.
      "exitOnSignal(130, () => { process.kill(process.pid, 'SIGTERM'); return new Promise(() => {}) })",
      "process.kill(process.pid, 'SIGTERM')",
      'setInterval(() => {}, 1000)',
    ].join('\n')
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: 'ignore',
    })
    started.push({ child, forget: () => {} })
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve))

    expect(code).toBe(130)
  })
})
