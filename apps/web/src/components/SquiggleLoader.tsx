import type { JSX } from 'react'
import LoaderMark from '../brand/loader-mark.svg?react'

/**
 * Branded inline loader for in-content waits with room to breathe: a dash
 * travelling along the signature (wb-loader in index.css). For affordances
 * under ~20px keep a plain ring spinner — the travel collapses into
 * flicker at that size (BRAND.md).
 */
export function SquiggleLoader({
  label,
  className = '',
}: {
  label: string
  className?: string
}): JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center justify-center gap-2 text-muted-foreground ${className}`}
    >
      <LoaderMark />
      <span>{label}</span>
    </div>
  )
}
