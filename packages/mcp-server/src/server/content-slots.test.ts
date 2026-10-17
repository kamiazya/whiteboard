import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { armContentSlots, createContentSlots } from './content-slots.js'
import { limitContentBody } from './routes/body-limit.js'

describe('createContentSlots', () => {
  it('counts a caller with no user against the total only', () => {
    const slots = createContentSlots({ perUser: 1, total: 2 })
    expect(typeof slots.take(null)).toBe('function')
    expect(typeof slots.take(null)).toBe('function')
    expect(slots.take(null)).toBe('total')
  })

  it('frees a slot once however many times it is released', () => {
    const slots = createContentSlots({ perUser: 2, total: 3 })
    const first = slots.take('ada')
    if (typeof first !== 'function') throw new Error('the first slot was refused')
    first()
    first()
    expect(typeof slots.take('ada')).toBe('function')
    expect(typeof slots.take('ada')).toBe('function')
    expect(slots.take('ada')).toBe('per_user')
  })
})

describe('limitContentBody', () => {
  it('frees the slot when the handler throws', async () => {
    const app = new Hono()
    app.use(
      '*',
      armContentSlots({
        slots: createContentSlots({ perUser: 1, total: 1 }),
        userOf: async () => 'ada',
        refused: () => {},
      }),
    )
    app.onError((_err, c) => c.json({ error: 'boom' }, 500))
    let calls = 0
    app.post('/upload', limitContentBody(1024, 'Upload'), () => {
      calls += 1
      throw new Error('boom')
    })

    const post = () => app.request('/upload', { method: 'POST', body: 'x' })
    expect((await post()).status).toBe(500)
    expect((await post()).status).toBe(500)
    expect(calls).toBe(2)
  })
})
