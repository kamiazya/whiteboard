// apps/web's jsdom vitest project previously ran unnamed (inheriting the
// package name @kamiazya/whiteboard-web), so `--project web-jsdom` matched
// nothing while a sibling `--project web-browser` in the same command still
// matched — silently running only the browser half and exiting 0. Naming
// this project is what makes the filter resolve at all; these assertions
// keep the name declared, keep the new `pnpm test:web-jsdom` script pointed
// at it, and keep it distinct from this app's other two named projects so a
// collision can't quietly union two projects under one filter.
import { describe, expect, it } from 'vitest'
import rootPkg from '../../../package.json' with { type: 'json' }
import browserConfigSource from '../vitest.browser.config.ts?raw'
import configSource from '../vitest.config.ts?raw'
import nodeConfigSource from '../vitest.node.config.ts?raw'

function projectName(source: string): string | undefined {
  return source.match(/name:\s*'([^']+)'/)?.[1]
}

describe('apps/web jsdom vitest project is named', () => {
  it("declares test.name: 'web-jsdom' in vitest.config.ts", () => {
    expect(projectName(configSource)).toBe('web-jsdom')
  })

  it('root package.json exposes a test:web-jsdom script targeting the named project', () => {
    const pkg = rootPkg as { scripts?: Record<string, string> }
    const script = pkg.scripts?.['test:web-jsdom']
    expect(script, 'root package.json must declare a test:web-jsdom script').toBeDefined()
    expect(script).toContain('--project web-jsdom')
  })

  it('does not collide with this app’s other named projects', () => {
    expect(projectName(configSource)).not.toBe(projectName(nodeConfigSource))
    expect(projectName(configSource)).not.toBe(projectName(browserConfigSource))
  })
})
