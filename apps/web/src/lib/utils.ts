import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

// Standard shadcn helper for conditionally merging Tailwind classes.
// Generated shadcn components rely on this to combine cva output and overrides safely.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
