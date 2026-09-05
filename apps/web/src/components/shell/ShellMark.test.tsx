import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConnectionState } from '../../lib/connection-state.js'
import { ShellMark } from './ShellMark.js'

afterEach(cleanup)

const DAEMON = (session: 'synced' | 'reconnecting' | 'sync-off'): ConnectionState => ({
  keeper: 'daemon',
  session,
})
const BROWSER = (storage: 'ok' | 'stuck' | 'failed'): ConnectionState => ({
  keeper: 'browser',
  storage,
})

describe('ShellMark', () => {
  it('claims no state when no page has published a session', () => {
    render(<ShellMark />)
    const mark = screen.getByTestId('shell-mark')
    // The shell's standing rule: an index or settings page holds no session,
    // and a mark that kept the last one would go on claiming it.
    expect(mark.getAttribute('data-keeper')).toBeNull()
    expect(mark.getAttribute('data-session')).toBeNull()
    expect(mark.querySelector('[data-testid="shell-mark-cap"]')).toBeNull()
  })

  // A healthy keeper draws NOTHING: no dot for a browser that is keeping,
  // none for a daemon that is synced. The mark speaks only for a condition
  // that asks something of the person — a write that is not landing, a
  // write the store refused, a session that dropped or was rejected.
  it.each([
    ['browser, ok', BROWSER('ok')],
    ['daemon, synced', DAEMON('synced')],
  ])('draws no cap for %s', (_name, state) => {
    render(<ShellMark state={state} />)
    expect(screen.queryByTestId('shell-mark-cap')).toBeNull()
    expect(screen.getByTestId('shell-mark-stroke').getAttribute('class') ?? '').not.toMatch(
      /wb-mark-broken/,
    )
  })

  it.each([
    ['browser, stuck', BROWSER('stuck')],
    ['daemon, reconnecting', DAEMON('reconnecting')],
    ['daemon, sync-off', DAEMON('sync-off')],
  ])('paints %s with the attention cap', (_name, state) => {
    render(<ShellMark state={state} />)
    expect(screen.getByTestId('shell-mark-cap').getAttribute('data-tone')).toBe('attention')
  })

  // The browser's store refusing a write is the browser not keeping — the
  // same shape sync-off has for the daemon (broken, dimmed), with the cap
  // hollow so the two conditions still read apart when both carry amber.
  it('paints a failed browser write as a broken stroke with a hollow cap', () => {
    render(<ShellMark state={BROWSER('failed')} />)
    expect(screen.getByTestId('shell-mark-stroke').getAttribute('class')).toMatch(/wb-mark-broken/)
    const cap = screen.getByTestId('shell-mark-cap')
    expect(cap.getAttribute('data-tone')).toBe('attention')
    expect(cap.getAttribute('data-shape')).toBe('ring')
    expect(screen.getByTestId('shell-mark').getAttribute('data-storage')).toBe('failed')
  })

  it('publishes the storage health as data for the page tests to read', () => {
    render(<ShellMark state={BROWSER('stuck')} />)
    expect(screen.getByTestId('shell-mark').getAttribute('data-storage')).toBe('stuck')
    expect(screen.getByTestId('shell-mark-cap').getAttribute('data-shape')).toBe('filled')
  })

  it('separates the two amber states by motion, since they share a tone', () => {
    // `reconnecting` and `sync-off` are both attention-coloured in StateDot's
    // closed set, so colour alone cannot tell them apart on a mark that has
    // no label. The travelling stroke is what does — and it is the loader's
    // own class, because "the pen is moving, work is happening" is already
    // what this app means by it.
    const { rerender } = render(<ShellMark state={DAEMON('reconnecting')} />)
    expect(screen.getByTestId('shell-mark-stroke').getAttribute('class')).toMatch(/wb-loader/)

    rerender(<ShellMark state={DAEMON('sync-off')} />)
    expect(screen.getByTestId('shell-mark-stroke').getAttribute('class')).not.toMatch(/wb-loader/)
    expect(screen.getByTestId('shell-mark').getAttribute('data-session')).toBe('sync-off')
  })

  it('does not celebrate a page that simply loaded already synced', () => {
    // Otherwise every navigation twinkles, and the gesture stops meaning
    // anything by the time something is actually wrong.
    render(<ShellMark state={DAEMON('synced')} />)
    expect(screen.getByTestId('shell-mark').getAttribute('data-gesture')).toBeNull()
  })

  it('celebrates only the recovery, not every render that stays synced', () => {
    const { rerender } = render(<ShellMark state={DAEMON('reconnecting')} />)
    expect(screen.getByTestId('shell-mark').getAttribute('data-gesture')).toBeNull()

    rerender(<ShellMark state={DAEMON('synced')} />)
    expect(screen.getByTestId('shell-mark').getAttribute('data-gesture')).toBe('recovered')

    // A re-render that changes nothing must not replay it — the gesture is
    // about the transition, and React re-renders for reasons of its own.
    rerender(<ShellMark state={DAEMON('synced')} />)
    expect(screen.getByTestId('shell-mark').getAttribute('data-gesture')).toBe('recovered')
  })

  it('ends the gesture the moment the session leaves synced', () => {
    // Leaving synced cancelled the timer but left the flag set, so the mark
    // went on claiming a gesture with no recovered session behind it.
    const { rerender } = render(<ShellMark state={DAEMON('reconnecting')} />)
    rerender(<ShellMark state={DAEMON('synced')} />)
    expect(screen.getByTestId('shell-mark').getAttribute('data-gesture')).toBe('recovered')

    // Well inside the gesture's own duration: this is the drop that arrives
    // before it has finished playing.
    rerender(<ShellMark />)
    expect(screen.getByTestId('shell-mark').getAttribute('data-gesture')).toBeNull()
  })

  it('plays the SECOND recovery too, on a session that keeps dropping', () => {
    // The sharper half of the same defect. A flag left set makes the next
    // `setRecovered(true)` a no-op — React bails on identical state, the
    // class never leaves the DOM, and the animation therefore never
    // restarts. The user who most needs the reassurance, on a connection
    // that drops repeatedly, is the one who would stop seeing it.
    const { rerender } = render(<ShellMark state={DAEMON('reconnecting')} />)
    rerender(<ShellMark state={DAEMON('synced')} />)
    expect(screen.getByTestId('shell-mark').getAttribute('data-gesture')).toBe('recovered')

    rerender(<ShellMark state={DAEMON('reconnecting')} />)
    expect(screen.getByTestId('shell-mark').getAttribute('data-gesture')).toBeNull()

    rerender(<ShellMark state={DAEMON('synced')} />)
    expect(screen.getByTestId('shell-mark').getAttribute('data-gesture')).toBe('recovered')
  })

  it('celebrates a recovery out of sync-off too', () => {
    const { rerender } = render(<ShellMark state={DAEMON('sync-off')} />)
    rerender(<ShellMark state={DAEMON('synced')} />)
    expect(screen.getByTestId('shell-mark').getAttribute('data-gesture')).toBe('recovered')
  })

  it('does not celebrate a later synced session that never dropped', () => {
    // The path the two cases above do not reach: recover, then MOVE to the
    // browser, then come back on a daemon. Nothing dropped on that last
    // step — it is a keeper change — so a flag left over from the earlier
    // recovery would make the mark congratulate a session that never fell
    // over.
    const { rerender } = render(<ShellMark state={DAEMON('reconnecting')} />)
    rerender(<ShellMark state={DAEMON('synced')} />)
    expect(screen.getByTestId('shell-mark').getAttribute('data-gesture')).toBe('recovered')

    rerender(<ShellMark state={{ keeper: 'browser', storage: 'ok' }} />)
    rerender(<ShellMark state={DAEMON('synced')} />)
    expect(screen.getByTestId('shell-mark').getAttribute('data-gesture')).toBeNull()
  })

  it('does not celebrate a keeper change, which is not a recovery', () => {
    // Browser -> daemon is a MOVE, narrated by its own flow. Borrowing the
    // recovery gesture for it would say "the session came back" about a
    // session that never dropped.
    const { rerender } = render(<ShellMark state={BROWSER('ok')} />)
    rerender(<ShellMark state={DAEMON('synced')} />)
    expect(screen.getByTestId('shell-mark').getAttribute('data-gesture')).toBeNull()
  })
})
