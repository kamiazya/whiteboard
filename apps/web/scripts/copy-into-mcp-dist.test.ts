import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyIntoMcpDist, shouldExcludeFromMcpDist } from './copy-into-mcp-dist.mjs'

describe('shouldExcludeFromMcpDist', () => {
  it('excludes the generated service worker', () => {
    expect(shouldExcludeFromMcpDist('sw.js')).toBe(true)
  })

  it('excludes the top-level workbox runtime chunk', () => {
    expect(shouldExcludeFromMcpDist('workbox-2fbc6a65.js')).toBe(true)
  })

  it('excludes the virtual:pwa-register glue chunk', () => {
    expect(shouldExcludeFromMcpDist('assets/virtual_pwa-register-CaDreUOZ.js')).toBe(true)
  })

  it('excludes the workbox-window library chunk', () => {
    expect(shouldExcludeFromMcpDist('assets/workbox-window.prod.es5-Bd17z0YL.js')).toBe(true)
  })

  it('keeps index.html and ordinary app assets', () => {
    expect(shouldExcludeFromMcpDist('index.html')).toBe(false)
    expect(shouldExcludeFromMcpDist('assets/index-B3ZKXgtV.js')).toBe(false)
    expect(shouldExcludeFromMcpDist('manifest.webmanifest')).toBe(false)
    expect(shouldExcludeFromMcpDist('icon-192.png')).toBe(false)
  })
})

describe('copyIntoMcpDist', () => {
  let workDir: string | undefined

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true })
    workDir = undefined
  })

  it('copies the build output while dropping service-worker assets', () => {
    workDir = mkdtempSync(join(tmpdir(), 'copy-into-mcp-dist-'))
    const src = join(workDir, 'src')
    const dest = join(workDir, 'dest')
    mkdirSync(join(src, 'assets'), { recursive: true })
    writeFileSync(join(src, 'index.html'), '<html></html>')
    writeFileSync(join(src, 'sw.js'), '// service worker')
    writeFileSync(join(src, 'workbox-2fbc6a65.js'), '// workbox runtime')
    writeFileSync(join(src, 'assets', 'index-B3ZKXgtV.js'), '// app entry')
    writeFileSync(join(src, 'assets', 'virtual_pwa-register-CaDreUOZ.js'), '// pwa register glue')

    copyIntoMcpDist(src, dest)

    expect(existsSync(join(dest, 'index.html'))).toBe(true)
    expect(existsSync(join(dest, 'assets', 'index-B3ZKXgtV.js'))).toBe(true)
    expect(existsSync(join(dest, 'sw.js'))).toBe(false)
    expect(existsSync(join(dest, 'workbox-2fbc6a65.js'))).toBe(false)
    expect(existsSync(join(dest, 'assets', 'virtual_pwa-register-CaDreUOZ.js'))).toBe(false)
  })

  it('throws a clear error when the source build is missing', () => {
    workDir = mkdtempSync(join(tmpdir(), 'copy-into-mcp-dist-'))
    const src = join(workDir, 'never-built')
    const dest = join(workDir, 'dest')
    expect(() => copyIntoMcpDist(src, dest)).toThrow(/run `vite build` first/)
  })
})
