// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAppLogger, reportCrash } from './app-logger.js'

describe('getAppLogger', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe('DEV=true path', () => {
    beforeEach(() => {
      vi.stubGlobal('import.meta', { env: { DEV: true } })
    })

    it('forwards error to console.error with name tag', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const logger = getAppLogger('test-name')
      logger.error('msg', 'ctx')
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0][0]).toContain('[test-name]')
      expect(spy.mock.calls[0][0]).toContain('msg')
      expect(spy.mock.calls[0][1]).toBe('ctx')
    })

    it('forwards warn to console.warn with name tag', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const logger = getAppLogger('test-name')
      logger.warn('wmsg', 42)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0][0]).toContain('[test-name]')
      expect(spy.mock.calls[0][0]).toContain('wmsg')
      expect(spy.mock.calls[0][1]).toBe(42)
    })

    it('forwards info to console.info with name tag', () => {
      const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
      const logger = getAppLogger('test-name')
      logger.info('imsg')
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0][0]).toContain('[test-name]')
    })

    it('forwards debug to console.debug with name tag', () => {
      const spy = vi.spyOn(console, 'debug').mockImplementation(() => {})
      const logger = getAppLogger('test-name')
      logger.debug('dmsg')
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0][0]).toContain('[test-name]')
    })
  })

  describe('PROD path (DEV=false)', () => {
    beforeEach(() => {
      vi.stubGlobal('import.meta', { env: { DEV: false } })
    })

    it('does not call console.error', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const logger = getAppLogger('prod')
      logger.error('silent')
      expect(spy).toHaveBeenCalledTimes(0)
    })

    it('does not call console.warn', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const logger = getAppLogger('prod')
      logger.warn('silent')
      expect(spy).toHaveBeenCalledTimes(0)
    })

    it('does not call console.info', () => {
      const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
      const logger = getAppLogger('prod')
      logger.info('silent')
      expect(spy).toHaveBeenCalledTimes(0)
    })

    it('does not call console.debug', () => {
      const spy = vi.spyOn(console, 'debug').mockImplementation(() => {})
      const logger = getAppLogger('prod')
      logger.debug('silent')
      expect(spy).toHaveBeenCalledTimes(0)
    })
  })

  describe('real import.meta.env.DEV (no global stub)', () => {
    // Regression: the logger must read the real Vite-provided import.meta.env.DEV
    // when nothing stubs globalThis['import.meta'] — this is the path the actual
    // running app takes. Vitest itself runs with import.meta.env.DEV === true,
    // so the fallback should behave like a real dev build here.
    it('logs because the real import.meta.env.DEV is true under vitest', () => {
      expect(import.meta.env.DEV).toBe(true)
      const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
      const logger = getAppLogger('real-env')
      logger.info('via real import.meta')
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0][0]).toContain('[real-env]')
    })
  })

  describe('name tag independence', () => {
    beforeEach(() => {
      vi.stubGlobal('import.meta', { env: { DEV: true } })
    })

    it('two loggers embed their own name tags independently', () => {
      const spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const loggerA = getAppLogger('alpha')
      const loggerB = getAppLogger('beta')
      loggerA.warn('from-a')
      loggerB.warn('from-b')
      expect(spyWarn).toHaveBeenCalledTimes(2)
      expect(spyWarn.mock.calls[0][0]).toContain('[alpha]')
      expect(spyWarn.mock.calls[1][0]).toContain('[beta]')
    })

    it('two loggers return independent objects', () => {
      const loggerA = getAppLogger('a')
      const loggerB = getAppLogger('b')
      expect(loggerA).not.toBe(loggerB)
    })
  })

  // reportCrash is the one app-logger channel that is NOT gated by
  // dev/prod: it exists so ErrorBoundary can still surface a crash report
  // after a real production build. These tests pin the contrast against the
  // ordinary levels, which stay silent in prod by design (see the PROD path
  // suite above).
  describe('reportCrash (production-visible crash channel)', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    })

    it('emits in a dev build', () => {
      vi.stubGlobal('import.meta', { env: { DEV: true } })
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      reportCrash('crash-name', 'boom happened', { detail: 'x' })
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0][0]).toContain('[crash-name]')
      expect(spy.mock.calls[0][0]).toContain('boom happened')
      expect(spy.mock.calls[0][1]).toEqual({ detail: 'x' })
    })

    it('still emits in a prod build, unlike every other AppLogger level', () => {
      vi.stubGlobal('import.meta', { env: { DEV: false } })
      const crashSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      reportCrash('crash-name', 'boom happened', { detail: 'x' })
      expect(crashSpy).toHaveBeenCalledTimes(1)
      expect(crashSpy.mock.calls[0][0]).toContain('[crash-name]')

      crashSpy.mockClear()
      const logger = getAppLogger('ordinary-diagnostic')
      logger.error('routine diagnostic, e.g. a debounced scene-sync retry')
      expect(crashSpy).toHaveBeenCalledTimes(0)
    })
  })
})
