import { describe, expect, it } from 'vitest'
import rootConfig from '../../../vitest.config.ts'
import jsdomConfig from '../vitest.config.ts'

describe('root vitest config', () => {
  it('carries the web-jsdom unhandled-error filter, which vitest reads from the root only', () => {
    // `--project web-jsdom` and `pnpm coverage` run under the root config, so a
    // filter left on the project is ignored there and the post-teardown React
    // scheduler error fails a run that CI's own wrapper passes.
    expect(jsdomConfig.test?.onUnhandledError).toBeTypeOf('function')
    expect(rootConfig.test?.onUnhandledError).toBe(jsdomConfig.test?.onUnhandledError)
  })
})
