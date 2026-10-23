import { useEffect, useRef } from 'react'
import type { EditorTool } from '../lib/editor-tool.js'
import { writeLastTool } from '../lib/initial-tool.js'

/**
 * Keeps the tool a document is being used in, and writes it when the
 * document is left (unmount, switching to another document, `pagehide`).
 *
 * The tool in use counts even when nobody chose it: someone working in an
 * empty board's default Select who adds content and reloads would otherwise
 * come back in Hand, because the content-based guess has flipped by then.
 * The opening tool is therefore latched per document, and an explicit choice
 * (the returned callback) replaces it. `writeLastTool` ignores the transient
 * tools, so only a resting tool is ever stored.
 */
export function useRememberedTool(
  documentKey: string,
  initialTool: EditorTool | undefined,
): (tool: EditorTool) => void {
  const toolByDocument = useRef(new Map<string, EditorTool>())
  const tools = toolByDocument.current
  if (initialTool !== undefined && !tools.has(documentKey)) tools.set(documentKey, initialTool)

  useEffect(() => {
    const flush = () => {
      const tool = tools.get(documentKey)
      if (tool !== undefined) writeLastTool(documentKey, tool)
    }
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [documentKey, tools])

  return (tool) => {
    tools.set(documentKey, tool)
    writeLastTool(documentKey, tool)
  }
}
