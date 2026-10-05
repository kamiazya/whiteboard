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
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setStderrLogDestination } from '../server/log.js'
import { main } from './dispatcher.js'

// `os.homedir()` reads the process's real environment, which a worker thread
// does not share with its `process.env`: under a threads pool (the mutation
// lane's) a stubbed HOME never reaches it and the install finds the machine's
// own browsers. The home dir is therefore replaced at the module, not the env.
const home = vi.hoisted(() => ({ override: undefined as string | undefined }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const homedir = () => home.override ?? actual.homedir()
  return { ...actual, homedir, default: { ...actual, homedir } }
})

// The dispatcher imports this lazily; resolving it here puts the module
// graph's load in collection, not in the first test's timeout.

let scratch: string
let stdout: string
let stderr: string
let restoreStderrLog: () => void

beforeEach(() => {
  home.override = undefined
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
  // What the logger writes is part of this command's stderr; the suite's
  // mute would hide it from the assertions on what a refusal prints.
  restoreStderrLog = setStderrLogDestination(true)
})
afterEach(() => {
  restoreStderrLog()
  vi.restoreAllMocks()
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
      home.override = join(scratch, 'home')
      mkdirSync(home.override)
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
  async function installFrom(entry: string): Promise<number> {
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, '')
    const argv = [...process.argv]
    vi.spyOn(process, 'argv', 'get').mockReturnValue([argv[0] ?? '', entry])
    return main([
      'native-host',
      'install',
      '--json',
      `--data-dir=${join(scratch, 'data')}`,
      `--manifest-dir=${join(scratch, 'hosts')}`,
    ])
  }

  it('is not flagged for a durable install', async () => {
    const code = await installFrom(
      join(
        scratch,
        'lib',
        'node_modules',
        '@kamiazya',
        'whiteboard-mcp',
        'dist',
        'cli',
        'index.js',
      ),
    )
    expect(code, stderr).toBe(0)
    expect(stderr).not.toContain('npx')
    expect(JSON.parse(stdout)).toMatchObject({ ok: true })
  })

  it('is not flagged when _npx is only part of a directory name', async () => {
    const code = await installFrom(join(scratch, 'my_npx_notes', 'cli.js'))
    expect(code, stderr).toBe(0)
    expect(stderr).not.toContain('npx')
  })

  it('says so on stderr while still answering ok on stdout', async () => {
    const code = await installFrom(join(scratch, '_npx', 'abc', 'cli.js'))
    expect(code, stderr).toBe(0)
    expect(stderr).toContain('npm install -g')
    expect(JSON.parse(stdout)).toMatchObject({ ok: true })
  })
})
