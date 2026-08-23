import { describe, expect, it, vi } from 'vitest'

import { main, USAGE } from './dispatcher.js'

const runSearchFetchModel = vi.hoisted(() => vi.fn())
vi.mock('./search-fetch-model.js', () => ({ runSearchFetchModel }))

function captureStdout(): { text: () => string; restore: () => void } {
  let text = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    text += String(chunk)
    return true
  })
  return { text: () => text, restore: () => spy.mockRestore() }
}

describe('whiteboard search fetch-model', () => {
  it('routes to the fetch command and writes its result as one JSON object', async () => {
    runSearchFetchModel.mockResolvedValue({
      result: { ok: true, model: 'Xenova/multilingual-e5-small' },
      exitCode: 0,
    })
    const stdout = captureStdout()
    try {
      const exitCode = await main(['search', 'fetch-model', '--json'])
      expect(exitCode).toBe(0)
      expect(JSON.parse(stdout.text())).toMatchObject({ ok: true })
    } finally {
      stdout.restore()
    }
  })

  it('forwards the command exit code so a failed fetch fails the shell', async () => {
    runSearchFetchModel.mockResolvedValue({
      result: { ok: false, failure: 'runtime-missing', remedy: 'install it' },
      exitCode: 1,
    })
    const stdout = captureStdout()
    try {
      expect(await main(['search', 'fetch-model', '--json'])).toBe(1)
    } finally {
      stdout.restore()
    }
  })

  it('reads the cache dir out of --data-dir rather than always the default', async () => {
    runSearchFetchModel.mockResolvedValue({ result: { ok: true }, exitCode: 0 })
    const stdout = captureStdout()
    try {
      await main(['search', 'fetch-model', '--json', '--data-dir=/tmp/wb-data'])
    } finally {
      stdout.restore()
    }
    expect(runSearchFetchModel).toHaveBeenLastCalledWith(
      expect.objectContaining({ cacheDir: '/tmp/wb-data/models' }),
    )
  })

  it('rejects an unknown search subcommand instead of falling through to daemon', async () => {
    expect(await main(['search', 'reindex', '--json'])).toBe(64)
  })

  it('is discoverable in the usage text', () => {
    expect(USAGE).toContain('whiteboard search fetch-model')
  })
})
