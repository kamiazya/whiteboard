import { lazy, Suspense } from 'react'

const AppShell = lazy(() => import('./AppShell.js').then((m) => ({ default: m.AppShell })))

/**
 * Entry-chunk shield for the shell: App.tsx lives in the eagerly-loaded
 * entry whose gzip budget is razor thin (scripts/smoke-bundle-size.mjs),
 * and a static AppShell import drags the popover/nudge dependency graph in
 * with it. The fallback reserves the shell's exact height so the swap-in
 * never shifts the page below.
 */
export function AppShellLazy({ daemon }: { daemon: boolean }) {
  return (
    <Suspense
      fallback={<div aria-hidden="true" className="h-10 shrink-0 border-b bg-background" />}
    >
      <AppShell daemon={daemon} />
    </Suspense>
  )
}
