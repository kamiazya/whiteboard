import { describe, expect, it, vi } from 'vitest'
import { launchQueueOf, newCanvasLaunchConsumer } from './launch-queue.js'
import { NEW_CANVAS_SHORTCUT } from './new-canvas-shortcut.js'

const ORIGIN = 'https://app.example'
const SHORTCUT = `${ORIGIN}${NEW_CANVAS_SHORTCUT.url}`

function consumerFor(documentUrl: string, holdsWork = false) {
  const open = vi.fn()
  const consume = newCanvasLaunchConsumer({}, { documentUrl, holdsWork: () => holdsWork, open })
  return { open, consume }
}

describe('the launch consumer for the New canvas shortcut', () => {
  it('opens the shortcut for a launch asking for a new canvas', () => {
    const { open, consume } = consumerFor(`${ORIGIN}/w/default/d/plan`)
    consume({ targetURL: SHORTCUT })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('leaves the launch that loaded the document to the page that is already there', () => {
    const { open, consume } = consumerFor(SHORTCUT)
    consume({ targetURL: SHORTCUT })
    expect(open).not.toHaveBeenCalled()
    // A later launch to the same address is the shortcut chosen again.
    consume({ targetURL: SHORTCUT })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('a consumer registered again does not take a later launch for the first', () => {
    const win = {}
    const open = vi.fn()
    const options = { documentUrl: SHORTCUT, holdsWork: () => false, open }
    newCanvasLaunchConsumer(win, options)({ targetURL: SHORTCUT })
    newCanvasLaunchConsumer(win, options)({ targetURL: SHORTCUT })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('does not leave a tab holding work a leave would lose', () => {
    const { open, consume } = consumerFor(`${ORIGIN}/`, true)
    consume({ targetURL: SHORTCUT })
    expect(open).not.toHaveBeenCalled()
  })

  it.each([
    ['a plain launch', `${ORIGIN}/`],
    ['another value of the parameter', `${ORIGIN}/?${NEW_CANVAS_SHORTCUT.key}=note`],
    ['no target', null],
    ['a target that is not a URL', 'not a url'],
  ])('%s opens nothing', (_label, targetURL) => {
    const { open, consume } = consumerFor(`${ORIGIN}/w/default`)
    consume({ targetURL })
    expect(open).not.toHaveBeenCalled()
  })
})

describe('launchQueueOf', () => {
  it('answers null where the browser has no launch queue', () => {
    expect(launchQueueOf({})).toBeNull()
    expect(launchQueueOf({ launchQueue: null })).toBeNull()
    expect(launchQueueOf({ launchQueue: { setConsumer: 'no' } })).toBeNull()
  })

  it("hands the consumer to the queue's own setConsumer", () => {
    const queue = {
      consumer: undefined as unknown,
      setConsumer(c: unknown) {
        this.consumer = c
      },
    }
    const consumer = () => {}
    launchQueueOf({ launchQueue: queue })?.setConsumer(consumer)
    expect(queue.consumer).toBe(consumer)
  })
})
