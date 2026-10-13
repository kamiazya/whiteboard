/**
 * The daemon's storage report, or the reason it could not be read — the one
 * reader of that route, for the card that shows it and the Settings page that
 * quotes its total.
 */

import {
  type StorageReportPayload,
  storageReportApiUrl,
  storageReportPayloadSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { messageOf } from '@kamiazya/whiteboard-model'
import { readDaemonJson } from './daemon-contract-error.js'

export async function readStorageReport(
  fetchApi: typeof globalThis.fetch,
): Promise<{ report: StorageReportPayload } | { error: string }> {
  try {
    const res = await fetchApi(storageReportApiUrl())
    if (!res.ok) return { error: `HTTP ${res.status}` }
    return { report: await readDaemonJson(storageReportApiUrl(), res, storageReportPayloadSchema) }
  } catch (err) {
    return { error: messageOf(err, String(err)) }
  }
}
