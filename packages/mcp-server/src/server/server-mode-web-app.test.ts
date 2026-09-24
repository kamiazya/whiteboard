/**
 * ADR-0047 decision 1: a server-mode keeper serves the web build that ships in
 * its image, from its own origin, marked as a server keeper so the app signs
 * in against it. Without a build it keeps answering with the placeholder.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mountServerModeWebApp, serverModeUiStatus } from './server-mode-web-app.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-server-mode-web-app-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function withBuild() {
  await writeFile(
    join(dir, 'index.html'),
    '<html><head><title>wb</title></head><body></body></html>',
  )
  await mkdir(join(dir, 'assets'))
  await writeFile(join(dir, 'assets', 'app.js'), 'console.log(1)')
  await writeFile(join(dir, 'favicon.svg'), '<svg/>')
}

function app() {
  const hono = new Hono()
  mountServerModeWebApp(hono, dir)
  return hono
}

const RUNTIME_CONFIG = 'window.__WHITEBOARD_RUNTIME_CONFIG__ = {"keeper":"server"}'

describe('mountServerModeWebApp', () => {
  it.for([
    '/',
    '/sign-in',
    '/w/plans',
  ])('answers %s with the app shell, marked as a server keeper', async (path) => {
    await withBuild()
    const res = await app().request(path)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain(RUNTIME_CONFIG)
    const nonce = /nonce="([^"]+)"/.exec(html)?.[1]
    expect(res.headers.get('content-security-policy')).toContain(`'nonce-${nonce}'`)
  })

  it('serves the build’s files as they are', async () => {
    await withBuild()
    expect(await (await app().request('/assets/app.js')).text()).toBe('console.log(1)')
    expect(await (await app().request('/favicon.svg')).text()).toBe('<svg/>')
  })

  it('answers a missing file 404 rather than with the app shell', async () => {
    await withBuild()
    expect((await app().request('/assets/missing.js')).status).toBe(404)
  })

  it('leaves the API paths to their own routes', async () => {
    await withBuild()
    expect((await app().request('/api/workspaces')).status).toBe(404)
    expect((await app().request('/mcp')).status).toBe(404)
  })

  it('reports the UI it serves, by whether the build is there', async () => {
    expect(serverModeUiStatus(dir)).toEqual({ buildPresent: false, ui: 'server-placeholder' })
    await withBuild()
    expect(serverModeUiStatus(dir)).toEqual({ buildPresent: true, ui: 'web-app' })
  })

  // A keeper run from source, with no web build, still answers a browser.
  it('answers with the placeholder when the image carries no build', async () => {
    const res = await app().request('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('server mode')
  })
})
