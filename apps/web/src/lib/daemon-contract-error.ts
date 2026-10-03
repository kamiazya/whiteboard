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

/**
 * The error for a response that failed its contract, reported on the way out.
 *
 * Reported where it is BUILT, which is where the parse fails: a surfacing
 * site reduces it to one sentence (or swallows it into a fallback), so the
 * route and the field that disagreed would otherwise exist nowhere. Callers
 * throw what this returns and never log it again, so a mismatch is one record.
 *
 * The first issue's path is in the message line, not only the data, because a
 * console shows an object collapsed and a message is what gets searched.
 */
export function daemonContractError(route: string, error: z.ZodError): DaemonContractError {
  const failure = new DaemonContractError(route, error.issues)
  const path = failure.issues[0]?.path.join('.') || '(root)'
  log.error(`response from ${route} failed its contract at ${path}`, {
    route,
    issues: failure.issues,
  })
  return failure
}

/** Parses a daemon answer, throwing (and so reporting) a `DaemonContractError` rather than a bare `ZodError`. */
export function parseDaemonResponse<T>(route: string, schema: z.ZodType<T>, json: unknown): T {
  const parsed = schema.safeParse(json)
  if (!parsed.success) throw daemonContractError(route, parsed.error)
  return parsed.data
}
