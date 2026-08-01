// Persisted-JSON contract for the generated-SBOM staleness sidecar
// (packages/mcp-server/_artifacts/npm-sbom.inputs.json). This is the single
// source of truth for the sidecar shape — the .mjs writer
// (scripts/release/sbom-fingerprint.mjs) and this schema's readers must never
// diverge, per this repo's zod-schema-discipline.

import { z } from 'zod'

const hexDigestSchema = (length: number) =>
  z
    .string()
    .regex(
      new RegExp(`^[0-9a-f]{${length}}$`),
      `expected a lowercase hex digest of length ${length}`,
    )

export const sbomFingerprintSidecarSchema = z
  .object({
    schemaVersion: z.literal(1),
    algorithm: z.literal('SHA-256'),
    // Repo-relative input path -> SHA-256 hex digest of that file's bytes.
    inputs: z
      .record(z.string().min(1), hexDigestSchema(64))
      .refine((inputs) => Object.keys(inputs).length > 0, 'inputs must be non-empty'),
    // SHA-512 of the SBOM file this sidecar was written alongside.
    sbomSha512: hexDigestSchema(128),
  })
  .strict()

// z.infer type kept internal — evaluateSbomArtifactState (sbom-artifact-state.ts)
// is the only consumer today and reads through sbomFingerprintSidecarSchema.parse
// directly, so a named exported type would be unused surface per knip.
type SbomFingerprintSidecar = z.infer<typeof sbomFingerprintSidecarSchema>
