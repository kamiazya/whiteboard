/**
 * The logger with NOTHING stubbed, in a real browser build. The jsdom suite
 * stubs `import.meta` for every case, so it never ran the branch a page
 * runs — and that branch read `DEV` off a bare `import.meta`, where Vite
 * injects no `env`, so every warn and error was silently dropped.
 */
import { expect, it } from 'vitest'
import { expectLoggedFailures } from '../test-utils/browser-setup.js'
import { getAppLogger } from './app-logger.js'

it('a warn from app code reaches the console in a dev build', () => {
  const seen = expectLoggedFailures()
  getAppLogger('probe').warn('reaches the console')
  expect(seen.join('\n')).toContain('[probe] reaches the console')
})
