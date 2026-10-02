import { z } from 'zod'
import { didKeyToEd25519PublicKey } from './did-key.js'

// instanceId (a per-daemon-start crypto.randomUUID) replaces the OS pid here.
// pid is reused by the OS across processes, so a stale record comparing pid
// alone can misidentify an unrelated process as "our" daemon; instanceId is
// unique per start and never reused, closing that identity-confusion window
// for the CLI's stop/status/doctor checks that read this endpoint.
// The daemon's durable signing identity (see server/security/daemon-identity.ts).
// publicKey is the raw Ed25519 public key, base64url. Advertising it is safe:
// trust comes from whoever verifies a signature against a key they already
// hold, never from the advertisement itself.
// `did` is the same key under the name the rest of the world uses for one
// (ADR-0035 decision 1) — derived from publicKey, never a second credential,
// and never what a pin is taken on. Optional for the same wire-compat reason
// `identity` itself is: a daemon predating it advertises the key alone.
//
// "Derived from publicKey" is CHECKED here rather than merely stated. The two
// fields claim to name one key, and a prefix test admits a well-formed did
// naming a different one: a responder could advertise the pinned publicKey
// beside its OWN did, and a verifier that imported the key from the did would
// then check signatures against the responder's key while believing it held
// the pin. Nothing reads `did` yet, which is exactly when the cheap place to
// close it is the contract — before a reader exists to trust it.
export const daemonIdentitySchema = z
  .object({
    alg: z.literal('Ed25519'),
    publicKey: z.string().min(1),
    did: z.string().startsWith('did:key:').optional(),
  })
  .refine(
    (identity) =>
      identity.did === undefined || didKeyToEd25519PublicKey(identity.did) === identity.publicKey,
    { message: 'did must decode to publicKey', path: ['did'] },
  )

export const daemonPingResponseSchema = z.object({
  ok: z.literal(true),
  instanceId: z.string(),
  // Optional for wire-compat with daemons predating the identity keypair;
  // current daemons always include it.
  identity: daemonIdentitySchema.optional(),
})

export type DaemonPingResponse = z.infer<typeof daemonPingResponseSchema>

export const runtimeStatusResponseSchema = z.object({
  ok: z.boolean(),
  pid: z.number(),
  // The HTTP listener, where there is one — server mode's. The local daemon
  // listens on no port at all (ADR-0050): it answers on `socketPath`, a Unix
  // socket or a Windows named pipe only its owner can open.
  host: z.string().optional(),
  port: z.number().optional(),
  baseUrl: z.string().optional(),
  socketPath: z.string().optional(),
  version: z.string(),
  startedAt: z.string(),
  uptimeMs: z.number(),
  idleForMs: z.number(),
  auth: z.object({ mode: z.string(), hasToken: z.boolean() }),
  storage: z.object({ dataDir: z.string(), dataDirWritable: z.boolean() }),
  // What UI the keeper serves: server mode serves the web app (or a
  // placeholder page when its image carries no build). The local daemon
  // serves none — the hosted app reaches it through the extension — so it
  // reports no `app` at all.
  app: z
    .object({
      served: z.boolean(),
      buildPresent: z.boolean(),
      ui: z.enum(['web-app', 'server-placeholder']),
    })
    .optional(),
  // `endpoint` is where an HTTP MCP client reaches `/mcp`: server mode's
  // public URL. The local daemon's `/mcp` is reached over its socket, through
  // the stdio proxy, so it names none.
  mcp: z.object({ httpEnabled: z.boolean(), endpoint: z.string().optional() }),
  clients: z.object({ connected: z.number(), ready: z.number() }),
  publicBaseUrl: z.string().optional(),
})

export type RuntimeStatusResponse = z.infer<typeof runtimeStatusResponseSchema>
