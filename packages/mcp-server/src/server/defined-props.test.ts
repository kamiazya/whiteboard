import { describe, expect, it } from 'vitest'

import { definedProps } from './defined-props.js'

describe('definedProps', () => {
  it('removes only undefined values', () => {
    expect(
      definedProps({
        keepZero: 0,
        keepFalse: false,
        keepNull: null,
        dropUndefined: undefined,
      }),
    ).toEqual({
      keepZero: 0,
      keepFalse: false,
      keepNull: null,
    })
  })
})
