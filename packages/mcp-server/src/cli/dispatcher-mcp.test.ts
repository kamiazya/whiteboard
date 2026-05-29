import { describe, expect, it, vi } from 'vitest'

// Pin the runtime contract for `whiteboard mcp` at the dispatcher
// boundary. We can't run the real stdio server in a unit test —
// `StdioServerTransport` reads from process.stdin and never resolves
// — so we mock the imported `main()` and assert routing only.

vi.mock('../server/mcp/index.js', () => ({
  main: vi.fn(async () => {
    // Default: pretend the stdio loop completed cleanly. Individual
    // tests override via `vi.mocked(...).mockImplementation(...)`.
  }),
}))

const mcpModule = await import('../server/mcp/index.js')
const { main } = await import('./dispatcher.js')

// Drive `main(['mcp'])` and capture stdout/stderr while running, but
// without ever awaiting the never-resolving happy-path promise. The
// previous racing-against-a-sentinel approach left I/O spies
// installed AND skipped stdout assertions on the sentinel branch,
// which silently masked stdout pollution.
async function runMcpAndCapture(argv: readonly string[] = ['mcp']): Promise<{ stdout: string; stderr: string }> {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const writeStdout = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    })
  const writeStderr = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    })
  try {
    // Fire-and-forget: the dispatcher's never-resolving branch keeps
    // the promise pending forever on the happy path, but anything
    // the dispatcher writes to stdout BEFORE that branch ran (or
    // tries to write later) will land in stdoutChunks.
    void main(argv)
    // dispatchMcp dynamically imports `../server/mcp/index.js` which
    // is itself an async hop, so settle through a real timer tick to
    // guarantee `main()` (the mocked one) has been invoked AND the
    // never-resolving branch has registered before we sample stdout.
    await new Promise((resolve) => setTimeout(resolve, 20))
    return { stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') }
  } finally {
    writeStdout.mockRestore()
    writeStderr.mockRestore()
  }
}

function captureStdio<T>(
  body: () => Promise<T>,
): Promise<{ result: T; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const writeStdout = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    })
  const writeStderr = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    })
  return body()
    .then((result) => ({ result, stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') }))
    .finally(() => {
      writeStdout.mockRestore()
      writeStderr.mockRestore()
    })
}

describe('CLI dispatcher: whiteboard mcp', () => {
  it('routes `whiteboard mcp` to the MCP stdio main() and writes nothing to stdout/stderr on the happy path', async () => {
    const mainMock = vi.mocked(mcpModule.main).mockImplementation(async () => {})

    const { stdout, stderr } = await runMcpAndCapture()

    expect(mainMock).toHaveBeenCalledTimes(1)
    // stdout MUST stay empty for `whiteboard mcp` — it's the
    // JSON-RPC channel and any prefix would corrupt the protocol.
    // This assertion always runs (no sentinel-branch escape) so a
    // regression that emits a JSON wrapper or human text BEFORE the
    // never-resolving await fails immediately.
    expect(stdout).toBe('')
    expect(stderr).toBe('')
  })

  it('startup error: stderr message is generic + redacted; stdout stays empty; exit 1', async () => {
    // Throw a deliberately leaky error message: tokens, paths, stack
    // frames. The redactor must scrub them all before they reach
    // stderr, since stderr is the only diagnostic surface this code
    // path exposes.
    vi.mocked(mcpModule.main).mockImplementation(async () => {
      throw new Error(
        'Authorization: Bearer secret-token-XYZ at /opt/wb/server.ts:42 — boom (file:/Users/me/db.sqlite)',
      )
    })

    const { result: exitCode, stdout, stderr } = await captureStdio(() => main(['mcp']))
    expect(exitCode).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toMatch(/MCP server error:/)
    // Defence-in-depth leak guard.
    expect(stderr).not.toContain('secret-token-XYZ')
    expect(stderr).not.toMatch(/Bearer/i)
    expect(stderr).not.toMatch(/Authorization/i)
    expect(stderr).not.toMatch(/\/opt\//)
    expect(stderr).not.toMatch(/\/Users\//)
    expect(stderr).not.toMatch(/\.ts:\d/)
    // No accidental daemon JSON wrappers / usage text either.
    expect(stderr).not.toContain('"ok"')
    expect(stderr).not.toContain('Currently supported')
  })

  it('no-arg invocation routes to stdio MCP — backward-compat for published configs that run `npx -y @kamiazya/whiteboard-mcp@latest`', async () => {
    // Published Codex / Claude config uses args: ['-y', '@kamiazya/whiteboard-mcp@latest']
    // which means the bin is invoked with no extra subcommand. The dispatcher
    // must fall through to the stdio MCP entrypoint rather than printing usage.
    const mainMock = vi.mocked(mcpModule.main).mockImplementation(async () => {})
    mainMock.mockClear()

    const { stdout, stderr } = await runMcpAndCapture([])

    expect(mainMock).toHaveBeenCalledTimes(1)
    expect(stdout).toBe('')
    expect(stderr).toBe('')
  })

  it('top-level USAGE block lists `whiteboard mcp`', async () => {
    vi.mocked(mcpModule.main).mockImplementation(async () => {})
    const { result: exitCode, stdout, stderr } = await captureStdio(() =>
      main(['this-is-not-a-real-command']),
    )
    expect(exitCode).toBe(64)
    expect(stdout).toBe('')
    expect(stderr).toMatch(/whiteboard mcp/)
  })
})
