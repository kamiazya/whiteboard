import type { ReplicaTier } from '@kamiazya/whiteboard-daemon-client/api-contracts/replica-key'

/**
 * Plain-language sentence per read-plane tier (ADR-0042), for the one
 * read-only line in Settings that tells a person what this device keeps of
 * a daemon-kept workspace. Declared once so a fourth tier is a type error
 * rather than a place the three sentences can fork — no "tier"/"replica"/
 * "epoch" jargon, since this reads to someone who has never heard those words.
 */
export const REPLICA_TIER_COPY = {
  'no-offline': 'Needs a connection. No copy is kept on this device.',
  offline: 'A copy is kept on this device while this tab stays open.',
  bounded: 'A copy is kept on this device for a limited time.',
} satisfies Record<ReplicaTier, string>
