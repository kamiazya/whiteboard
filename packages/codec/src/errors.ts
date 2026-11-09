import type { z } from 'zod'

/**
 * Every stage a total parser (parseOkf / parseSpatial) can fail at. Kept as
 * a closed union (not a bare `string`) so a caller can exhaustively switch
 * on it without an `else` branch silently swallowing a new stage.
 */
export type CodecParseStage =
  | 'yaml'
  | 'frontmatter-schema'
  | 'json-syntax'
  | 'json-canvas-schema'
  | 'ocif-schema'

/**
 * One place a schema refused: where, which check, and why. Zod's issues are
 * one shape of it; the Rust core's OKF reader answers this much and no more
 * (ADR-0054), so a caller reads these three fields and nothing Zod-specific.
 */
export interface CodecIssue {
  readonly code: string
  readonly path: PropertyKey[]
  readonly message: string
}

export interface CodecParseError {
  readonly stage: CodecParseStage
  readonly message: string
  /**
   * Populated for schema-stage failures ('frontmatter-schema' /
   * 'json-canvas-schema' / 'ocif-schema') so a caller can render field-level detail;
   * syntax-stage failures ('yaml' / 'json-syntax') have no ZodError to
   * report and carry an empty array instead of `undefined` so callers never
   * need an extra null-check to iterate over it.
   */
  readonly issues: readonly CodecIssue[]
}

export type CodecParseResult<T> = { ok: true; value: T } | { ok: false; error: CodecParseError }

/**
 * Total parsers never throw a raw ZodError/SyntaxError — every failure path
 * funnels through this constructor so the stage/message/issues shape stays
 * uniform across the OKF and JSON-Canvas parsers.
 */
export function codecFailure(
  stage: CodecParseStage,
  message: string,
  zodError?: z.ZodError,
): { ok: false; error: CodecParseError } {
  return {
    ok: false,
    error: { stage, message, issues: zodError?.issues ?? [] },
  }
}

export function codecSuccess<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}
