import { z } from 'zod'
import { SYNC_WRITE_REFUSAL_CODES } from './generated/refusals.js'

/**
 * The codes a keeper answers a sync write it refused for what its bytes would
 * do — one per bound the write broke. Listed once, in `contracts/api/refusals.json`
 * (the generated `SYNC_WRITE_REFUSAL_CODES`), because both sides
 * of the wire, both keepers and the Rust operations spell them: the daemon's refusals are typed by
 * this enum, the client's contract parses with it, and the browser keeper
 * answers the same breach with the same code. A spelling held in two places
 * drifts without failing anything, since each side's tests pin only its own.
 */
export const syncWriteRefusalCodeSchema = z.enum(SYNC_WRITE_REFUSAL_CODES)
export type SyncWriteRefusalCode = z.infer<typeof syncWriteRefusalCodeSchema>
