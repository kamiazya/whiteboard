import { describe, expect, it } from 'vitest'
import { checkDependencyDirection } from './direction-check.js'

describe('checkDependencyDirection', () => {
  it('passes model (zod-only dependency)', () => {
    const violations = checkDependencyDirection({
      name: '@kamiazya/whiteboard-model',
      dependencies: { zod: '^4.0.0' },
    })
    expect(violations).toHaveLength(0)
  })

  it('passes codec depending on model + third-party libs', () => {
    const violations = checkDependencyDirection({
      name: '@kamiazya/whiteboard-codec',
      dependencies: {
        '@kamiazya/whiteboard-model': 'workspace:*',
        zod: '^4.0.0',
        unified: '^11.0.0',
      },
    })
    expect(violations).toHaveLength(0)
  })

  it('fails a non-dev edge that reverses the architecture-map direction', () => {
    const violations = checkDependencyDirection({
      name: '@kamiazya/whiteboard-model',
      dependencies: { '@kamiazya/whiteboard-codec': 'workspace:*' },
    })
    expect(violations).toEqual([
      {
        packageName: '@kamiazya/whiteboard-model',
        dependencyName: '@kamiazya/whiteboard-codec',
      },
    ])
  })

  it('ignores devDependencies entirely (only "dependencies" is inspected)', () => {
    const violations = checkDependencyDirection({
      name: '@kamiazya/whiteboard-model',
      dependencies: {},
    })
    expect(violations).toHaveLength(0)
  })

  it('fails a shared-layer package depending on the mcp-server composition root', () => {
    const violations = checkDependencyDirection({
      name: '@kamiazya/whiteboard-model',
      dependencies: { '@kamiazya/whiteboard-mcp': 'workspace:*' },
    })
    expect(violations).toEqual([
      {
        packageName: '@kamiazya/whiteboard-model',
        dependencyName: '@kamiazya/whiteboard-mcp',
      },
    ])
  })

  it('passes canvas-viewer (no internal deps, only third-party UI libs)', () => {
    const violations = checkDependencyDirection({
      name: '@kamiazya/whiteboard-canvas-viewer',
      dependencies: {
        '@excalidraw/excalidraw': 'catalog:',
        react: 'catalog:',
        'react-dom': 'catalog:',
        zod: 'catalog:',
      },
    })
    expect(violations).toHaveLength(0)
  })
})
