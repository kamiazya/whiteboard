// @vitest-environment node
// apps/web's jsdom vitest project previously ran unnamed (inheriting the
// package name @kamiazya/whiteboard-web), so `--project web-jsdom` matched
// nothing while a sibling `--project web-browser` in the same command still
// matched — silently running only the browser half and exiting 0. Naming this
// project is what makes the filter resolve at all, so this file asserts the
// name the runner actually gave it (not the config source), and keeps the
// `pnpm test:web-jsdom` script pointed at that name. Uniqueness needs no
// guard: vitest refuses to start on duplicate project names.
import { describe, expect, it } from 'vitest'
import rootPkg from '../../../package.json' with { type: 'json' }

describe('apps/web jsdom vitest project is named', () => {
  it('runs under the project name web-jsdom', ({ task }) => {
    expect(task.file.projectName).toBe('web-jsdom')
  })

  it('root package.json exposes a test:web-jsdom script targeting the named project', () => {
    expect(rootPkg.scripts['test:web-jsdom']).toContain('--project web-jsdom')
  })
})
