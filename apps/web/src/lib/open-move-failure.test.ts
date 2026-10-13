/**
 * What preparing a move to a daemon reports, by what failed: the daemon's own
 * refusal, a response that broke its contract, an unreachable daemon, this
 * browser's unreadable record, or a defect on this device.
 */
import { StoredDocumentUnreadableError } from '@kamiazya/whiteboard-ports'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { DaemonApiError } from './daemon-api-client.js'
import { DaemonContractError } from './daemon-contract-error.js'
import { reach } from './fetch-failure.js'
import { OPEN_CONTRACT_FAILURE, OPEN_FAILURE_COPY, openFailureReason } from './open-move-failure.js'
import { ReplicaKeyWithheldError } from './sealed-document-store.js'

const BASE = 'http://127.0.0.1:3099'

async function rejectionOf(attempt: Promise<unknown>): Promise<unknown> {
  try {
    await attempt
  } catch (err) {
    return err
  }
  throw new Error('expected the attempt to reject')
}

describe('openFailureReason', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("passes a daemon refusal's own sentence through and logs its status", async () => {
    vi.spyOn(console, 'warn')
    const refusal = new DaemonApiError('Workspace listing is not allowed for this origin.', 403)

    expect(openFailureReason(refusal, BASE)).toBe(
      'Workspace listing is not allowed for this origin.',
    )
    await expectLoggedFailure('daemon refused the workspace listing')
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('daemon refused the workspace listing'),
      expect.objectContaining({ daemonBaseUrl: BASE, status: 403 }),
    )
  })

  it('reports a response that broke its contract as unexpected, not as a network failure', () => {
    const broken = new DaemonContractError('GET /api/workspaces', [])

    expect(openFailureReason(broken, BASE)).toBe(OPEN_CONTRACT_FAILURE)
  })

  it('reports a fetch that never reached the daemon as a network failure', async () => {
    const unreachable = await rejectionOf(reach(Promise.reject(new TypeError('Failed to fetch'))))

    expect(openFailureReason(unreachable, BASE)).toBe(OPEN_FAILURE_COPY.network)
  })

  it("reports this browser's unreadable record as unreadable, with a log record", async () => {
    const unreadable = new StoredDocumentUnreadableError('malformed', 'a delta does not decode')

    expect(openFailureReason(unreadable, BASE)).toBe(OPEN_FAILURE_COPY.unreadable)
    await expectLoggedFailure(OPEN_FAILURE_COPY.unreadableLog)
  })

  it('reports a withheld replica key as an unreadable record, never a reconnect', () => {
    expect(openFailureReason(new ReplicaKeyWithheldError('01ARZ3NDEKTSV4RRFFQ69G5FE0'), BASE)).toBe(
      OPEN_FAILURE_COPY.unreadable,
    )
  })

  it('reports a bare TypeError from this device as a device failure, naming it in the log', async () => {
    vi.spyOn(console, 'warn')

    expect(openFailureReason(new TypeError('x is undefined'), BASE)).toBe(OPEN_FAILURE_COPY.device)
    await expectLoggedFailure(OPEN_FAILURE_COPY.deviceLog)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(OPEN_FAILURE_COPY.deviceLog),
      expect.objectContaining({ daemonBaseUrl: BASE, name: 'TypeError' }),
    )
  })
})
