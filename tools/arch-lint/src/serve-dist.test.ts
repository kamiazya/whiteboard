/**
 * The static dist server the smoke and measure scripts share.
 *
 * Five scripts each wrote their own: five MIME tables (three of them missing
 * `.wasm`, `.json` or `.woff2`, so a font or a worker bundle was served as
 * `application/octet-stream` to the browser the script was checking), and two
 * traversal policies — three servers joined the decoded request path onto the
 * root and read whatever it named. This holds the one definition's behaviour.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

interface Served {
  readonly server: Server
  readonly port: number
  readonly origin: string
  readonly close: () => Promise<void>
}
interface HookAnswer {
  readonly status: number
  readonly body?: string
}
interface ServeDistOptions {
  readonly root: string
  readonly headers?: Readonly<Record<string, string>>
  readonly fallback?: 'any-missing' | 'extensionless'
  readonly onRequest?: (
    req: IncomingMessage,
    res: ServerResponse,
    context: { readonly pathname: string },
  ) => HookAnswer | undefined | Promise<HookAnswer | undefined>
  readonly transform?: (pathname: string, body: Buffer) => Buffer | string
}
const { serveDist } = (await import(
  pathToFileURL(join(REPO_ROOT, 'tools/checks/src/serve-dist.mjs')).href
)) as { serveDist: (options: ServeDistOptions) => Promise<Served> }

interface Reply {
  readonly status: number
  readonly type: string | undefined
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly text: string
}

/** A raw request, because `fetch` normalises `..` and `%2e` away before the server sees them. */
function get(port: number, path: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          type: res.headers['content-type'],
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }),
      )
    })
    req.on('error', reject)
    req.end()
  })
}

const INDEX = '<!doctype html><title>app</title>'
const SECRET = 'outside-the-root'

let scratch: string
let root: string
let served: Served

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'serve-dist-'))
  root = join(scratch, 'dist')
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(scratch, 'secret.txt'), SECRET)
  writeFileSync(join(root, 'index.html'), INDEX)
  for (const name of [
    'a.js',
    'a.css',
    'a.json',
    'a.svg',
    'a.png',
    'a.ico',
    'a.wasm',
    'a.woff2',
    'a.ttf',
    'a.webmanifest',
    'a.unknown',
  ]) {
    writeFileSync(join(root, 'assets', name), name)
  }
  served = await serveDist({ root })
})

afterAll(async () => {
  await served.close()
  rmSync(scratch, { recursive: true, force: true })
})

describe('serveDist content types', () => {
  const TYPES: ReadonlyArray<readonly [string, string]> = [
    ['/', 'text/html; charset=utf-8'],
    ['/assets/a.js', 'text/javascript; charset=utf-8'],
    ['/assets/a.css', 'text/css; charset=utf-8'],
    ['/assets/a.json', 'application/json; charset=utf-8'],
    ['/assets/a.svg', 'image/svg+xml'],
    ['/assets/a.png', 'image/png'],
    ['/assets/a.ico', 'image/x-icon'],
    ['/assets/a.wasm', 'application/wasm'],
    ['/assets/a.woff2', 'font/woff2'],
    ['/assets/a.ttf', 'font/ttf'],
    ['/assets/a.webmanifest', 'application/manifest+json'],
    ['/assets/a.unknown', 'application/octet-stream'],
  ]
  it.each(TYPES)('%s is %s', async (path, type) => {
    const reply = await get(served.port, path)
    expect(reply.status).toBe(200)
    expect(reply.type).toBe(type)
  })
})

describe('serveDist traversal', () => {
  // The URL parser folds `..` and `%2e%2e` into the path before the server
  // sees it; an encoded SEPARATOR survives it and decodes into a traversal.
  it.each([
    '/%2E%2E%2Fsecret.txt',
    '/assets/..%2f..%2fsecret.txt',
    '/%2e%2e%2fdist-sibling%2fx.txt',
  ])('refuses %s with 403 and never reads outside the root', async (path) => {
    mkdirSync(join(scratch, 'dist-sibling'), { recursive: true })
    writeFileSync(join(scratch, 'dist-sibling', 'x.txt'), SECRET)
    const reply = await get(served.port, path)
    expect(reply.status).toBe(403)
    expect(reply.text).not.toContain(SECRET)
  })

  it.each([
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/%2e%2e%5csecret.txt',
  ])('never leaks the outside file through %s', async (path) => {
    expect((await get(served.port, path)).text).not.toContain(SECRET)
  })

  it('answers a malformed escape with a client error rather than crashing', async () => {
    expect((await get(served.port, '/%E0%A4%A')).status).toBe(400)
    expect((await get(served.port, '/')).status).toBe(200)
  })
})

describe('serveDist single-page fallback', () => {
  it('serves index.html for a route no file answers', async () => {
    const reply = await get(served.port, '/w/default/notes/readme.md')
    expect(reply.status).toBe(200)
    expect(reply.text).toBe(INDEX)
    expect(reply.type).toBe('text/html; charset=utf-8')
  })

  it('serves index.html for a directory', async () => {
    expect((await get(served.port, '/assets')).text).toBe(INDEX)
  })

  it('prefers a real file over the fallback', async () => {
    expect((await get(served.port, '/assets/a.js')).text).toBe('a.js')
  })

  it('under fallback: extensionless a missing file with an extension is a 404', async () => {
    const strict = await serveDist({ root, fallback: 'extensionless' })
    try {
      expect((await get(strict.port, '/assets/missing.js')).status).toBe(404)
      expect((await get(strict.port, '/w/default')).text).toBe(INDEX)
      expect((await get(strict.port, '/assets/a.js')).text).toBe('a.js')
    } finally {
      await strict.close()
    }
  })
})

describe('serveDist caller hooks', () => {
  it('adds the caller headers and lets the content type win over them', async () => {
    const hosted = await serveDist({
      root,
      headers: { 'cache-control': 'no-store', 'content-type': 'text/plain' },
    })
    try {
      const reply = await get(hosted.port, '/assets/a.css')
      expect(reply.headers['cache-control']).toBe('no-store')
      expect(reply.type).toBe('text/css; charset=utf-8')
    } finally {
      await hosted.close()
    }
  })

  it('answers from onRequest when it returns a response, and serves on when it does not', async () => {
    const seen: string[] = []
    const hooked = await serveDist({
      root,
      onRequest: (_req, _res, { pathname }) => {
        seen.push(pathname)
        return pathname.endsWith('a.js') ? { status: 503, body: 'refused' } : undefined
      },
    })
    try {
      const refused = await get(hooked.port, '/assets/a.js')
      expect([refused.status, refused.text]).toEqual([503, 'refused'])
      expect((await get(hooked.port, '/assets/a.css')).status).toBe(200)
      expect(seen).toEqual(['/assets/a.js', '/assets/a.css'])
    } finally {
      await hooked.close()
    }
  })

  it('awaits an async onRequest and answers from what it resolves to', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const held = await serveDist({
      root,
      onRequest: async (_req, _res, { pathname }) => {
        await gate
        return pathname === '/' ? { status: 503, body: 'late' } : undefined
      },
    })
    try {
      const pending = get(held.port, '/')
      release()
      const reply = await pending
      expect([reply.status, reply.text]).toEqual([503, 'late'])
      expect((await get(held.port, '/assets/a.css')).status).toBe(200)
    } finally {
      await held.close()
    }
  })

  it('lets transform rewrite a body by the path that was asked for', async () => {
    const rewriting = await serveDist({
      root,
      transform: (pathname, body) => (pathname === '/assets/a.js' ? `${body}+tail` : body),
    })
    try {
      expect((await get(rewriting.port, '/assets/a.js')).text).toBe('a.js+tail')
      expect((await get(rewriting.port, '/assets/a.css')).text).toBe('a.css')
    } finally {
      await rewriting.close()
    }
  })

  it('reports an origin on the loopback interface', () => {
    expect(served.origin).toBe(`http://127.0.0.1:${served.port}`)
  })
})
