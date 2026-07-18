import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runStartupSmoke } from './startup.smoke-impl.js'

describe('runStartupSmoke', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'whiteboard-startup-smoke-test-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('fails when the process exits immediately, even with exit code 0', async () => {
    const entry = join(root, 'exits-immediately.js')
    writeFileSync(entry, 'process.exit(0)\n')

    await expect(runStartupSmoke({ entry, root, waitMs: 200 })).rejects.toThrow(
      /exited with code 0/,
    )
  })

  it('does not treat stdin EOF (stdio: "ignore") as a premature exit false-pass', async () => {
    // A real MCP entrypoint now exits on stdin EOF (see stdio-lifecycle.ts).
    // If runStartupSmoke ever went back to spawning with stdin: 'ignore',
    // that EOF would make every real entrypoint exit almost immediately
    // with code 0 and this smoke would wrongly report success. Lock in a
    // long-lived process (never touches stdin) staying alive for waitMs.
    const entry = join(root, 'stays-alive.js')
    writeFileSync(entry, 'setTimeout(() => process.exit(0), 10_000)\n')

    await expect(runStartupSmoke({ entry, root, waitMs: 200 })).resolves.toBeUndefined()
  })
})
