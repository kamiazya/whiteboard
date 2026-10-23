import { useContext, useEffect } from 'react'
import { UNSAFE_NavigationContext } from 'react-router-dom'

/** The slice of the router's history object a push recorder wraps. */
interface PushableNavigator {
  push(to: unknown, state?: unknown): void
}

/**
 * Records every history PUSH the router performs into `pushed`, from inside
 * the Router. A render-time reader of the location cannot see a push that a
 * replace in the same commit covers, so a test of "replaced, not pushed" has to
 * watch the history object itself.
 */
export function useRecordPushes(pushed: string[]): void {
  // react-router types this context as unknown on purpose; the memory and
  // browser histories both carry `push`.
  const { navigator } = useContext(UNSAFE_NavigationContext) as unknown as {
    navigator: PushableNavigator
  }
  useEffect(() => {
    const push = navigator.push.bind(navigator)
    navigator.push = (to, state) => {
      pushed.push(typeof to === 'string' ? to : String((to as { pathname?: string }).pathname))
      push(to, state)
    }
    return () => {
      navigator.push = push
    }
  }, [navigator, pushed])
}
