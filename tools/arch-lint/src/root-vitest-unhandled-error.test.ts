// vitest reads `onUnhandledError` from the ROOT config only, so a filter left
// on a project is ignored by every run through the root config — a project
// filter, `pnpm test:web-jsdom`, the coverage lane — while CI's own web suite
// config carries it up. The same run then passes in one runner and fails in
// the other on an error the web jsdom setup has already ruled environmental.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

type ConfigModule = { default: { test?: { onUnhandledError?: unknown } } }
// lazy-import: loaded by path, since a relative import of the root configs
// leaves this workspace and `relative-import-escape` refuses it.
const load = async (path: string) =>
  ((await import(pathToFileURL(join(REPO_ROOT, path)).href)) as ConfigModule).default

const rootConfig = await load('vitest.config.ts')
const webJsdomConfig = await load('apps/web/vitest.config.ts')

describe('root vitest config', () => {
  it('carries the web jsdom unhandled-error filter, the one vitest reads', () => {
    expect(webJsdomConfig.test?.onUnhandledError).toBeTypeOf('function')
    expect(rootConfig.test?.onUnhandledError).toBe(webJsdomConfig.test?.onUnhandledError)
  })
})
