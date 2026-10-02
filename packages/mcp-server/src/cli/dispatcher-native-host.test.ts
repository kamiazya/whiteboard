/**
 * `whiteboard native-host`, through the dispatcher: which subcommands exist,
 * and what each refusal does with the two streams. `native-host run`'s stdout
 * is the browser's protocol channel, so a refusal answers on stderr and
 * leaves stdout empty; `install` answers one JSON object on stdout.
 *
 * `run` itself (stdin to the daemon and back) is `native-host.subprocess.test.ts`,
 * which needs a real child process; the relay is `daemon/native-host`'s own.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from './dispatcher.js'
// The dispatcher imports this lazily; resolving it here puts the module
// graph's load in collection, not in the first test's timeout.
import { transientInstallWarning } from './native-host.js'

let scratch: string
let stdout: string
let stderr: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'wb-dispatcher-native-host-'))
  stdout = ''
  stderr = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk)
    return true
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(scratch, { recursive: true, force: true })
})

describe('whiteboard native-host refusals', () => {
  it('refuses an install without --json: exit 64, the flag named on stderr, nothing on stdout', async () => {
    expect(await main(['native-host', 'install', `--data-dir=${join(scratch, 'data')}`])).toBe(64)
    expect(stderr).toContain('--json')
    expect(stdout).toBe('')
    expect(readdirSync(scratch)).toEqual([])
  })

  it('refuses an unknown subcommand: exit 64, the usage on stderr, nothing on stdout', async () => {
    expect(await main(['native-host', 'uninstall'])).toBe(64)
    expect(stderr).toContain('Unknown native-host subcommand')
    expect(stderr).toContain('whiteboard native-host install --json')
    expect(stdout).toBe('')
  })

  it('refuses a bare native-host the same way', async () => {
    expect(await main(['native-host'])).toBe(64)
    expect(stderr).toContain('Unknown native-host subcommand')
    expect(stdout).toBe('')
  })

  it('refuses an install flag it does not know: exit 64, the reason on stderr, nothing on stdout', async () => {
    expect(await main(['native-host', 'install', '--json', '--no-such-flag'])).toBe(64)
    expect(stderr).toContain('--no-such-flag')
    expect(stdout).toBe('')
  })
})

describe('whiteboard native-host install', () => {
  it('writes the manifest where it was told and answers ok with exit 0', async () => {
    const manifestDir = join(scratch, 'hosts')
    const code = await main([
      'native-host',
      'install',
      '--json',
      `--data-dir=${join(scratch, 'data')}`,
      `--manifest-dir=${manifestDir}`,
    ])
    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({ ok: true })
    expect(readdirSync(manifestDir)).toHaveLength(1)
  })

  // On Windows the default manifest locations are registry keys, which always
  // exist, so "no browser found" has no such premise there.
  it.skipIf(process.platform === 'win32')(
    'answers ok:false with exit 1 when no browser is installed and none was named',
    async () => {
      const home = join(scratch, 'home')
      mkdirSync(home)
      vi.stubEnv('HOME', home)
      const code = await main([
        'native-host',
        'install',
        '--json',
        `--data-dir=${join(scratch, 'data')}`,
      ])
      expect(code).toBe(1)
      expect(JSON.parse(stdout)).toMatchObject({ ok: false })
      expect(stdout.trimEnd().split('\n')).toHaveLength(1)
    },
  )
})

describe('a native host installed from npx', () => {
  it.each([
    '/home/u/.npm/_npx/323b5192267f46e3/node_modules/@kamiazya/whiteboard-mcp/dist/cli/index.js',
    'C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\3231\\node_modules\\whiteboard\\index.js',
  ])('is flagged as pointing into a cache npx replaces: %s', (entry) => {
    expect(transientInstallWarning(entry)).toMatch(/npm install -g/)
  })

  it('is not flagged for a durable install', () => {
    expect(
      transientInstallWarning('/usr/lib/node_modules/@kamiazya/whiteboard-mcp/dist/cli/index.js'),
    ).toBeUndefined()
    expect(transientInstallWarning('/home/u/my_npx_notes/cli.js')).toBeUndefined()
  })

  it('says so on stderr while still answering ok on stdout', async () => {
    const entry = join(scratch, '_npx', 'abc', 'cli.js')
    mkdirSync(join(scratch, '_npx', 'abc'), { recursive: true })
    writeFileSync(entry, '')
    const argv = [...process.argv]
    vi.spyOn(process, 'argv', 'get').mockReturnValue([argv[0] ?? '', entry])
    const code = await main([
      'native-host',
      'install',
      '--json',
      `--data-dir=${join(scratch, 'data')}`,
      `--manifest-dir=${join(scratch, 'hosts')}`,
    ])
    expect(code, stderr).toBe(0)
    expect(stderr).toContain('npx')
    expect(JSON.parse(stdout)).toMatchObject({ ok: true })
  })
})
