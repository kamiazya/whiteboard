import type { RecordOps } from '../record-ops.js'
import {
  exportProjection,
  importBytes,
  moveView,
  type RecordLease,
  read,
  versionOf,
  viewAt,
  write,
} from './lease.js'

/** `RecordOps` over an engine lease: every operation is the engine's own call. */
export const leaseOps: RecordOps<RecordLease> = {
  read,
  write: (record, batch) => write(record, batch, { judge: 'none' }),
  importJudged: importBytes,
  versionOf,
  viewAt,
  moveView,
  exportProjection,
}
