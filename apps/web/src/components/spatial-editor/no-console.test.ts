// @vitest-environment node
import { describe, expect, it } from 'vitest'

const modules = import.meta.glob('./**/*.{ts,tsx}', { query: '?raw', import: 'default' })

describe('no console.* in spatial-editor source', () => {
  const sourceFiles = Object.keys(modules).filter((path) => !path.includes('.test.'))

  it('scans at least the expected production files', () => {
    expect(sourceFiles.length).toBeGreaterThanOrEqual(9)
  })

  for (const path of sourceFiles) {
    it(`${path} contains no console.* call`, async () => {
      const loader = modules[path]
      const source = (await loader?.()) as string
      expect(source).not.toMatch(/console\./)
    })
  }
})
