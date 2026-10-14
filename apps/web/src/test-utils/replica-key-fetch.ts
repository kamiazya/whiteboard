/**
 * The daemon's `/replica-key` route as a fetch double, and the sealed replica
 * a page test reads.
 *
 * ONE answer rather than one per test file: every replica test needs the
 * daemon to hand over a workspace key, and each copy re-spelled the contract
 * by hand. The body is parsed through `replicaKeyResponseSchema` before it is
 * served, so a fixture the real client would refuse (a bounded tier with no
 * lease, a key of the wrong length) fails here rather than as a page that
 * mysteriously stays locked.
 */

import { replicaKeyResponseSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/replica-key'
import { bytesToBase64Url } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import type { z } from 'zod'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import { connectReplicaKeeper, markReplica } from '../lib/replica-store.js'
import { jsonResponse } from './json-response.js'

type ReplicaKeyBody = z.input<typeof replicaKeyResponseSchema>

/** 32 bytes of AES-256-GCM key material. */
export const REPLICA_TEST_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
/** 16 bytes of HKDF salt. */
const REPLICA_TEST_SALT = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i)

/**
 * The contract's own fields, plus the key and salt as raw bytes — the body
 * carries them base64url-encoded. `leaseExpiresAt` is required by the
 * contract iff `tier` is `bounded`.
 */
type ReplicaKeyOptions = Partial<Pick<ReplicaKeyBody, 'tier' | 'leaseExpiresAt' | 'keyId'>> & {
  readonly key?: Uint8Array
  readonly salt?: Uint8Array
}

/** A `/replica-key` body that keeps the daemon's contract. */
export function replicaKeyBody(options: ReplicaKeyOptions = {}): ReplicaKeyBody {
  const body: ReplicaKeyBody = {
    workspaceKey: bytesToBase64Url(options.key ?? REPLICA_TEST_KEY),
    workspaceKeySalt: bytesToBase64Url(options.salt ?? REPLICA_TEST_SALT),
    tier: options.tier ?? 'offline',
    ...(options.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: options.leaseExpiresAt }),
    ...(options.keyId === undefined ? {} : { keyId: options.keyId }),
  }
  return replicaKeyResponseSchema.parse(body)
}

function urlOf(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input)
}

/**
 * Answers `/replica-key` with a key, and every other URL through `otherwise`
 * — which by default throws, so a route the test did not expect is loud.
 */
export function replicaKeyFetch(
  options: ReplicaKeyOptions = {},
  otherwise: (url: string, init?: RequestInit) => Response | Promise<Response> = (url) => {
    throw new Error(`unexpected fetch ${url}`)
  },
): typeof fetch {
  const body = replicaKeyBody(options)
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    if (url.endsWith('/replica-key')) return jsonResponse(body)
    return otherwise(url, init)
  }) as typeof fetch
}

/** A daemon refusing every request with a membership reason, as `/replica-key` refuses one. */
export function replicaKeyRefusalFetch(reason: string): typeof fetch {
  return (async () => jsonResponse({ error: reason, message: reason }, 403)) as typeof fetch
}

/**
 * Writes a replica record through the SEALED path — the keeper connected and
 * the workspace marked as a replica before the save — because a page that
 * reads a replica reads sealed bytes in production, and a plaintext fixture
 * would pass its key-withheld branches over content never withheld from
 * anything. The keeper stays connected; the test's teardown disconnects it.
 */
export async function seedReplicaRecord(seed: {
  readonly daemonBaseUrl: string
  readonly workspaceId: string
  readonly build: (record: LoroDoc) => void
  readonly fetch?: typeof fetch
}): Promise<void> {
  connectReplicaKeeper({ baseUrl: seed.daemonBaseUrl, fetch: seed.fetch ?? replicaKeyFetch() })
  markReplica(seed.workspaceId, seed.daemonBaseUrl)
  const record = new LoroDoc()
  seed.build(record)
  record.commit()
  await new BrowserWorkspaceDocs().save(seed.workspaceId, record)
}
