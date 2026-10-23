import { useCallback, useRef } from 'react'

/**
 * The renames a top bar has sent and not yet seen answered.
 *
 * Every keystroke in the title box is its own rename and they settle out of
 * order, so anything that moves the document by path has to wait for them, or
 * the last name lands on an address that no longer holds the document. A name
 * the daemon refused is not one the address may follow either, so the NEWEST
 * rename's answer decides whether the waiting step runs.
 */
export function useRenameQueue() {
  const inFlightRef = useRef(new Set<Promise<unknown>>())
  const latestTicketRef = useRef(0)
  const latestRefusalRef = useRef<string | null>(null)

  /** Records `write`, answered with why it was refused or null once saved; returns it. */
  const track = useCallback((write: () => Promise<string | null>) => {
    const ticket = ++latestTicketRef.current
    const sent = write()
    inFlightRef.current.add(sent)
    void sent.then((answer) => {
      inFlightRef.current.delete(sent)
      if (ticket === latestTicketRef.current) latestRefusalRef.current = answer
    })
    return sent
  }, [])

  /** Runs `then` once no rename is in flight, unless the newest was refused. */
  const afterRenamesLand = useCallback((then: () => void): void => {
    const drain = async (): Promise<void> => {
      while (inFlightRef.current.size > 0) await Promise.allSettled([...inFlightRef.current])
      if (latestRefusalRef.current === null) then()
    }
    void drain()
  }, [])

  return { track, afterRenamesLand }
}
