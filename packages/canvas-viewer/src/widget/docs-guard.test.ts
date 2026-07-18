import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Regression guard for the widget build's docs: a build-only artifact with
// no docs pointer is invisible to the two downstream consumers (HTML
// export, MCP Apps widget) that need to find it. This asserts the exact
// prose promised in the widget slice spec, not just "docs mention widgets
// somewhere" — a vague match would pass even if the artifact path or
// regen command silently drifted from what's actually shipped.
const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const repoRoot = join(packageRoot, '..', '..')

describe('widget build docs', () => {
  it('records the artifact path and regen command in docs/contributing/development.md', () => {
    const development = readFileSync(
      join(repoRoot, 'docs', 'contributing', 'development.md'),
      'utf8',
    )

    expect(development).toContain('dist/widget/canvas-viewer.html')
    expect(development).toContain('pnpm --filter @kamiazya/whiteboard-canvas-viewer build:widget')
  })

  it("records the dev/prod export-gap stance in the package's README", () => {
    const readme = readFileSync(join(packageRoot, 'README.md'), 'utf8')

    expect(readme).toContain('Dev/prod export gap')
    expect(readme).toContain('smoke:widget')
  })
})
