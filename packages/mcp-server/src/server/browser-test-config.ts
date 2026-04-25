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
