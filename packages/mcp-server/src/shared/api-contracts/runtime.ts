import { z } from 'zod'

// instanceId (a per-daemon-start crypto.randomUUID) replaces the OS pid here.
// pid is reused by the OS across processes, so a stale record comparing pid
// alone can misidentify an unrelated process as "our" daemon; instanceId is
// unique per start and never reused, closing that identity-confusion window
// for the CLI's stop/status/doctor checks that read this endpoint.
// The daemon's durable signing identity (see server/security/daemon-identity.ts).
// publicKey is the raw Ed25519 public key, base64url. Advertising it is safe:
// trust comes from the web app PINNING the key at /pair consent time and
// verifying signatures against the pin, never from the advertisement itself.
export const daemonIdentitySchema = z.object({
  alg: z.literal('Ed25519'),
  publicKey: z.string().min(1),
})

export type DaemonIdentityInfo = z.infer<typeof daemonIdentitySchema>

export const daemonPingResponseSchema = z.object({
  ok: z.literal(true),
  instanceId: z.string(),
  // Optional for wire-compat with daemons predating the identity keypair;
  // current daemons always include it.
  identity: daemonIdentitySchema.optional(),
})

export type DaemonPingResponse = z.infer<typeof daemonPingResponseSchema>

// POST /api/runtime/verify: a caller-random nonce (base64url, 16-32 decoded
// bytes) is answered with a signature over ["wb-verify-v1", nonce, origin]
// so a browser can challenge a loopback responder to prove it holds the
// pinned daemon's private key. Public (like ping) and unreplayable (fresh
// nonce per challenge).
export const runtimeVerifyRequestSchema = z
  .object({
    nonce: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/, 'nonce must be base64url')
      .refine((value) => {
        const bytes = Buffer.from(value, 'base64url')
        return bytes.length >= 16 && bytes.length <= 32
      }, 'nonce must decode to 16-32 bytes'),
  })
  .strict()

export const runtimeVerifyResponseSchema = z
  .object({
    alg: z.literal('Ed25519'),
    publicKey: z.string().min(1),
    signature: z.string().min(1),
  })
  .strict()

export type RuntimeVerifyResponse = z.infer<typeof runtimeVerifyResponseSchema>

export const runtimeStatusResponseSchema = z.object({
  ok: z.boolean(),
  pid: z.number(),
  host: z.string(),
  port: z.number(),
  baseUrl: z.string(),
  version: z.string(),
  startedAt: z.string(),
  uptimeMs: z.number(),
  idleForMs: z.number(),
  auth: z.object({ mode: z.string(), hasToken: z.boolean() }),
  storage: z.object({ dataDir: z.string(), dataDirWritable: z.boolean() }),
  // 'web-app' is the canonical apps/web build (dist/web-app), served by the
  // local daemon. 'server-placeholder' is the minimal static page served at
  // server-mode's root (apps/web is not served there — server-mode has no
  // token/session-acquisition flow apps/web's provider model can use).
  app: z.object({
    served: z.boolean(),
    buildPresent: z.boolean(),
    ui: z.enum(['web-app', 'server-placeholder']),
  }),
  mcp: z.object({ httpEnabled: z.boolean(), endpoint: z.string() }),
  clients: z.object({ connected: z.number(), ready: z.number() }),
  publicBaseUrl: z.string().optional(),
})

export type RuntimeStatusResponse = z.infer<typeof runtimeStatusResponseSchema>
