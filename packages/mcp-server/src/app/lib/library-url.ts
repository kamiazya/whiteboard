import {
  isExternalUrlPolicyError,
  validateBrowserExternalUrl,
} from '../../shared/external-url-policy.js'
import { getAppLogger } from './app-logger.js'

const log = getAppLogger('library')

function warnRejectedLibraryUrl(rawUrl: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  log.warn('skipped unsafe URL', rawUrl, message)
}

export function getImportableLibraryUrl(rawUrl: string): string | null {
  try {
    return validateBrowserExternalUrl(rawUrl).toString()
  } catch (error) {
    if (isExternalUrlPolicyError(error)) {
      warnRejectedLibraryUrl(rawUrl, error)
      return null
    }
    throw error
  }
}

export function getInstalledLibraryUrls(urls: string[]): string[] {
  return urls.flatMap((url) => {
    const safeUrl = getImportableLibraryUrl(url)
    return safeUrl === null ? [] : [safeUrl]
  })
}

export function getHashLibraryUrl(hash: string): string | null {
  const match = hash.match(/#addLibrary=([^&]+)/)
  if (!match) return null
  return getImportableLibraryUrl(decodeURIComponent(match[1]))
}
