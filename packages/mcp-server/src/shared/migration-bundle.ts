/**
 * MigrationBundle: the JSON contract exported by browser-local canvases so
 * they can be re-imported into a daemon-backed workspace (or another
 * browser-local instance). Zod is the single source of truth per
 * zod-schema-discipline; MigrationBundle is derived via z.infer, never a
 * parallel hand-written interface.
 *
 * This module imports only 'zod' — no Node builtins, no src/server|cli|daemon
 * imports — so it stays safe to bundle into the browser app.
 *
 * v1 keeps `canvases` as an array even though the current export/import flow
 * only ever produces/accepts exactly one canvas; enforcing length === 1 is a
 * consumer-side (import route) concern, not a schema-shape concern.
 */
import { z } from 'zod'

const migrationSceneSchema = z
  .object({
    elements: z.array(z.unknown()),
    // Excalidraw's appState/files shapes are vendor-owned and evolve outside
    // this repo's control; z.record(z.unknown()) is deliberately loose here
    // rather than a gap in the schema.
    appState: z.record(z.string(), z.unknown()).optional(),
    files: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const migrationCanvasSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    scene: migrationSceneSchema,
  })
  .strict()

export const migrationBundleSchema = z
  .object({
    format: z.literal('whiteboard-migration'),
    version: z.literal(1),
    sourceProvider: z.literal('browser-local'),
    createdAt: z.string(),
    canvases: z.array(migrationCanvasSchema),
  })
  .strict()

export type MigrationBundle = z.infer<typeof migrationBundleSchema>
