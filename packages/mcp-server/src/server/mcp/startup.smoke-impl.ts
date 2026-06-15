import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface RunStartupSmokeOptions {
  entry: string
  root: string
  waitMs?: number
}

const FATAL_PATTERNS = [/SyntaxError/, /Cannot find module/, /does not provide an export/]

export async function runStartupSmoke({
  entry,
  root,
  waitMs = 3000,
}: RunStartupSmokeOptions): Promise<void> {
  const tmpDataDir = mkdtempSync(join(tmpdir(), 'whiteboard-smoke-'))

  const childArgs = entry.endsWith('.ts') ? ['--import', 'tsx/esm', entry] : [entry]
  const child = spawn('node', childArgs, {
    cwd: root,
    env: { ...process.env, WHITEBOARD_DATA_DIR: tmpDataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stderrBuf = ''
  let exited = false
  let exitCode: number | null = null

  child.stderr!.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString()
  })
  child.on('exit', (code) => {
    exited = true
    exitCode = code
  })

  const cleanup = () => {
    if (!exited) {
      try {
        child.kill('SIGTERM')
      } catch {}
    }
    rmSync(tmpDataDir, { recursive: true, force: true })
  }

  // Ensures cleanup runs even when process.exit() is called externally (e.g. SIGINT).
  process.once('exit', cleanup)

  try {
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs))

    const fatal = FATAL_PATTERNS.find((p) => p.test(stderrBuf))
    if (fatal) {
      throw new Error(`[mcp-smoke] matched ${fatal}${stderrBuf ? `\n${stderrBuf}` : ''}`)
    }
    if (exited && exitCode !== 0 && exitCode !== null) {
      throw new Error(
        `[mcp-smoke] MCP exited with code ${exitCode} within ${waitMs}ms${
          stderrBuf ? `\n${stderrBuf}` : ''
        }`,
      )
    }

    console.log(`[mcp-smoke] OK: MCP stayed alive for ${waitMs}ms`)
  } finally {
    process.removeListener('exit', cleanup)
    cleanup()
  }
}
