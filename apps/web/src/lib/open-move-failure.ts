/**
 * What preparing a move of this browser's workspace to a daemon tells the
 * person when it failed.
 *
 * Preparing the move reads the daemon's workspace list AND this browser's own
 * record, so a failure is reported by which of the two failed: someone whose
 * stored copy cannot be read must not be sent to check a connection that works.
 */
import { getAppLogger } from './app-logger.js'
import { DaemonApiError } from './daemon-api-client.js'
import { DaemonContractError } from './daemon-contract-error.js'
import { describeTransferFailure, type FailureCopy } from './keeper-transfer-failure.js'

const log = getAppLogger('open-move-failure')

export const OPEN_FAILURE_COPY: FailureCopy = {
  network: 'Could not reach the daemon to prepare the move.',
  unreadable: "This browser's copy of this workspace could not be read, so it cannot be moved.",
  device: 'This workspace could not be prepared on this device to move it.',
  unreadableLog: 'stored workspace could not be read; move not prepared',
  deviceLog: 'move preparation failed on this device',
}

export const OPEN_CONTRACT_FAILURE =
  'The daemon answered with an unexpected response, so the move was not prepared.'

export function openFailureReason(err: unknown, daemonBaseUrl: string): string {
  // The daemon answered and refused: its own sentence says why.
  if (err instanceof DaemonApiError) {
    log.warn('daemon refused the workspace listing; move not prepared', {
      daemonBaseUrl,
      status: err.status,
    })
    return err.message
  }
  // Already logged where it was raised, with the route and the issues.
  if (err instanceof DaemonContractError) return OPEN_CONTRACT_FAILURE
  const failure = describeTransferFailure(err, OPEN_FAILURE_COPY, {
    log,
    fields: { daemonBaseUrl },
  })
  // The browser keeper's own record is read without a replica key, so a
  // withheld key can only mean that record could not be read.
  return failure.kind === 'withheld' ? OPEN_FAILURE_COPY.unreadable : failure.reason
}
