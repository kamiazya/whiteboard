import { describe, expect, it } from 'vitest'

import { migrationBundleSchema } from './migration-bundle.js'

function validBundle() {
  return {
    format: 'whiteboard-migration' as const,
    version: 1 as const,
    sourceProvider: 'browser-local' as const,
    createdAt: '2026-07-05T00:00:00.000Z',
    canvases: [
      {
        id: 'canvas-1',
        name: 'My Canvas',
        scene: { elements: [{ id: 'el-1', type: 'rectangle' }] },
      },
    ],
  }
}

describe('migrationBundleSchema', () => {
  it('parses a valid v1 bundle with one canvas and round-trips deeply equal', () => {
    const bundle = validBundle()
    const parsed = migrationBundleSchema.parse(bundle)
    expect(parsed).toEqual(bundle)
  })

  it('parses a bundle with multiple canvases (array form is the schema contract)', () => {
    const bundle = validBundle()
    const multi = {
      ...bundle,
      canvases: [...bundle.canvases, { ...bundle.canvases[0], id: 'canvas-2' }],
    }
    expect(() => migrationBundleSchema.parse(multi)).not.toThrow()
  })

  it('parses scene without optional appState/files', () => {
    const bundle = validBundle()
    expect(bundle.canvases[0].scene).not.toHaveProperty('appState')
    expect(() => migrationBundleSchema.parse(bundle)).not.toThrow()
  })

  it('parses scene with appState and files present', () => {
    const bundle = validBundle()
    const withExtras = {
      ...bundle,
      canvases: [
        {
          ...bundle.canvases[0],
          scene: {
            ...bundle.canvases[0].scene,
            appState: { viewBackgroundColor: '#fff' },
            files: { 'file-1': { mimeType: 'image/png' } },
          },
        },
      ],
    }
    expect(() => migrationBundleSchema.parse(withExtras)).not.toThrow()
  })

  it('rejects an unknown top-level key (strict)', () => {
    const bundle = { ...validBundle(), extra: 'nope' }
    expect(() => migrationBundleSchema.parse(bundle)).toThrow()
  })

  it('rejects an unknown key inside a canvas entry (strict)', () => {
    const bundle = validBundle()
    const withExtra = {
      ...bundle,
      canvases: [{ ...bundle.canvases[0], extra: 'nope' }],
    }
    expect(() => migrationBundleSchema.parse(withExtra)).toThrow()
  })

  it('rejects an unknown key inside scene (strict)', () => {
    const bundle = validBundle()
    const withExtra = {
      ...bundle,
      canvases: [{ ...bundle.canvases[0], scene: { ...bundle.canvases[0].scene, extra: 'nope' } }],
    }
    expect(() => migrationBundleSchema.parse(withExtra)).toThrow()
  })

  it('rejects the wrong format string', () => {
    const bundle = { ...validBundle(), format: 'something-else' }
    expect(() => migrationBundleSchema.parse(bundle)).toThrow()
  })

  it('rejects version other than the literal 1', () => {
    expect(() => migrationBundleSchema.parse({ ...validBundle(), version: 2 })).toThrow()
    expect(() => migrationBundleSchema.parse({ ...validBundle(), version: '1' })).toThrow()
  })

  it('rejects a sourceProvider other than browser-local', () => {
    const bundle = { ...validBundle(), sourceProvider: 'daemon' }
    expect(() => migrationBundleSchema.parse(bundle)).toThrow()
  })

  it('rejects a missing createdAt or canvases field', () => {
    const bundle = validBundle() as Record<string, unknown>
    const { createdAt: _createdAt, ...withoutCreatedAt } = bundle
    expect(() => migrationBundleSchema.parse(withoutCreatedAt)).toThrow()
    const { canvases: _canvases, ...withoutCanvases } = bundle
    expect(() => migrationBundleSchema.parse(withoutCanvases)).toThrow()
  })

  it('rejects non-array elements in scene', () => {
    const bundle = validBundle()
    const invalid = {
      ...bundle,
      canvases: [{ ...bundle.canvases[0], scene: { elements: 'not-an-array' } }],
    }
    expect(() => migrationBundleSchema.parse(invalid)).toThrow()
  })
})
