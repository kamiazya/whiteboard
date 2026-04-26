import { describe, it, expect } from 'vitest'
import { parseCanvasId } from './canvas-id.js'
import { validationErrorBody } from '../../validators.js'

describe('parseCanvasId', () => {
  it('case 242', () => {
    expect(parseCanvasId('abc/canvas-a')).toEqual({ workspaceId: 'abc', slug: 'canvas-a' })
  })

  it('case 243', () => {
    expect(parseCanvasId('abc/621/header')).toEqual({ workspaceId: 'abc', slug: '621/header' })
    expect(parseCanvasId('abc/621/header-v2/layout')).toEqual({
      workspaceId: 'abc',
      slug: '621/header-v2/layout',
    })
  })

  it('case 244', () => {
    expect(() => parseCanvasId('nocanvas')).toThrow('Invalid canvasId')
  })

  it('case 245', () => {
    expect(() => parseCanvasId('/slug-only')).toThrow('Invalid canvasId')
    expect(() => parseCanvasId('session-only/')).toThrow('Invalid canvasId')
  })

  it('case 246', () => {
    try {
      parseCanvasId('bad.sid/slug')
      throw new Error('expected parseCanvasId to throw')
    } catch (error) {
      expect(validationErrorBody(error)).toEqual({
        error: 'invalid_session_id',
        message:
          'Invalid workspaceId "bad.sid": only ASCII letters, digits, "_" and "-" are allowed',
      })
    }
  })

  it('case 247', () => {
    try {
      parseCanvasId('sid/bad.slug')
      throw new Error('expected parseCanvasId to throw')
    } catch (error) {
      expect(validationErrorBody(error)).toEqual({
        error: 'invalid_slug',
        message: 'Invalid slug "bad.slug": segment "bad.slug" contains \'.\' (only letters, digits, and \'-\' are allowed)',
      })
    }
  })
})
