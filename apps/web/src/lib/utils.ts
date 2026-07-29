import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

// Standard shadcn helper for conditionally merging Tailwind classes.
// Generated shadcn components rely on this to combine cva output and overrides safely.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Display-only capitalization of the default branch identifier for the
// Variation/Combine UI vocabulary. The identifier itself ('main') must keep
// flowing unchanged through comparisons and API payloads — only call this
// where a name is rendered as label text.
export function displayBranchName(name: string): string {
  return name === 'main' ? 'Main' : name
}
