import type { z } from 'zod'

/**
 * Why a write was refused, as data: the stage the registry's own check stopped
 * at and what that stage knows. The message words the same facts for a person;
 * a caller that compares one implementation's refusal with another's reads
 * this instead of the sentence.
 */
export type FacetWriteRefusal =
  | { readonly stage: 'malformed-key' }
  | { readonly stage: 'not-current'; readonly current: string }
  | { readonly stage: 'invalid'; readonly issues: readonly z.core.$ZodIssue[] }
  | {
      readonly stage: 'unregistered-asset'
      readonly field: string
      readonly id: string
      readonly kind: string
      readonly registered: readonly string[]
    }
