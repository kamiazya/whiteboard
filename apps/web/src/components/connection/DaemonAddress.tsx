import { isBridgeDaemon } from '../../lib/extension-bridge-fetch.js'

/**
 * Where a daemon is reached, as a person reads it: its host, or — for a
 * daemon reached through the extension (ADR-0050), whose address is a
 * reserved name nothing answers — the extension itself.
 */
export function DaemonAddress({ baseUrl }: { baseUrl: string }) {
  if (isBridgeDaemon(baseUrl)) return <>the whiteboard extension</>
  return <span className="font-mono text-xs">{baseUrl.replace(/^https?:\/\//, '')}</span>
}
