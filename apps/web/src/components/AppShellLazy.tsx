import { lazy, Suspense } from 'react'
import type { AppShellProps } from './AppShell.js'

const AppShell = lazy(() => import('./AppShell.js').then((m) => ({ default: m.AppShell })))

/**
 * Entry-chunk shield for the shell: App.tsx lives in the eagerly-loaded
 * entry whose gzip budget is razor thin (scripts/smoke-bundle-size.mjs),
 * and a static AppShell import drags the popover/nudge dependency graph in
 * with it. The fallback reserves the shell's exact height so the swap-in
 * never shifts the page below.
 */
export function AppShellLazy(props: AppShellProps) {
  return (
    <Suspense
      fallback={<div aria-hidden="true" className="h-10 shrink-0 border-b bg-background" />}
    >
      <AppShell {...props} />
    </Suspense>
  )
}
