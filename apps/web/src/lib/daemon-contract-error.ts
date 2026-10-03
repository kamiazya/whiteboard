import type { z } from 'zod'
import { getAppLogger } from './app-logger.js'

const log = getAppLogger('daemon-contract')

/**
 * What a person is told when a daemon's answer does not parse. One sentence
 * for every route: the page and the daemon are built apart and skew routinely,
 * and which field disagreed is for the log, not for someone mid-task.
 */
export const DAEMON_CONTRACT_COPY =
  'The daemon sent a response this page could not read. Reloading, or updating the app or the daemon, usually fixes it.'

/**
 * A daemon response that came back successfully but failed its Zod contract.
 *
 * A class rather than a message so a caller classifies it with `instanceof`
 * instead of matching on wording that lives in another file, and so the route
 * and the issues survive to whoever logs or reports it.
 */
export class DaemonContractError extends Error {
  constructor(
    readonly route: string,
    readonly issues: z.ZodError['issues'],
  ) {
    super(DAEMON_CONTRACT_COPY)
    this.name = 'DaemonContractError'
  }
}

/** The error for a response that failed its contract. Building it reports nothing; see `logDaemonContractError`. */
export function daemonContractError(route: string, error: z.ZodError): DaemonContractError {
  return new DaemonContractError(route, error.issues)
}

/**
 * Reports a mismatch where a person is shown the failure, so the log says
 * which route and field disagreed while the screen says one generic sentence.
 *
 * Reported by the caller that surfaces the failure rather than where the
 * parse fails: a read a caller deliberately swallows (a names list that falls
 * back to empty) is not a failure anyone sees, and logging it at the throw
 * would put an error record behind every such fallback.
 *
 * The first issue's path is in the message line, not only the data, because a
 * console shows an object collapsed and a message is what gets searched.
 */
export function logDaemonContractError({ route, issues }: DaemonContractError): void {
  const path = issues[0]?.path.join('.') || '(root)'
  log.error(`response from ${route} failed its contract at ${path}`, { route, issues })
}
