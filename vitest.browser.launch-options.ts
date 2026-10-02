// How a Vitest browser project launches Chromium: Playwright's own build unless
// WHITEBOARD_CHROME_PATH names one. A root module because its importers are
// test CONFIGS — `vitest.browser.shared.ts` and apps/web's docs-snapshots
// config — and neither belongs to the daemon package whose source tree it used
// to be reached through. It is also imported without a build, which a package
// export (resolved to the gitignored `dist/`) is not.
export type BrowserLaunchOptions = {
  executablePath?: string
}

export function resolveBrowserLaunchOptions(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): BrowserLaunchOptions {
  const executablePath = env.WHITEBOARD_CHROME_PATH?.trim()

  if (!executablePath) {
    return {}
  }

  return { executablePath }
}
