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

  it('fails a reversing peerDependency and a reversing optionalDependency', () => {
    expect(
      checkDependencyDirection({
        name: '@kamiazya/whiteboard-model',
        peerDependencies: { '@kamiazya/whiteboard-codec': 'workspace:*' },
        optionalDependencies: { '@kamiazya/whiteboard-ports': 'workspace:*' },
      }),
    ).toEqual([
      { packageName: '@kamiazya/whiteboard-model', dependencyName: '@kamiazya/whiteboard-codec' },
      { packageName: '@kamiazya/whiteboard-model', dependencyName: '@kamiazya/whiteboard-ports' },
    ])
  })

  it('ignores a reversing devDependency by default', () => {
    const violations = checkDependencyDirection({
      name: '@kamiazya/whiteboard-model',
      dependencies: {},
      devDependencies: { '@kamiazya/whiteboard-codec': 'workspace:*' },
    })
    expect(violations).toHaveLength(0)
  })

  it('fails a reversing devDependency when includeDevDependencies is set', () => {
    const violations = checkDependencyDirection(
      {
        name: '@kamiazya/whiteboard-mcp',
        dependencies: {},
        devDependencies: {
          '@kamiazya/whiteboard-server-core': 'workspace:*',
          '@kamiazya/whiteboard-web': 'workspace:*',
        },
      },
      { includeDevDependencies: true },
    )
    expect(violations).toEqual([
      { packageName: '@kamiazya/whiteboard-mcp', dependencyName: '@kamiazya/whiteboard-web' },
    ])
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
