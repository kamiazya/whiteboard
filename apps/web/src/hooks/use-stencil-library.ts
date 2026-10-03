/**
 * The facet registry the editor's inspector offers stencils from and its
 * writer accepts them through: the deployment's, plus the stencils the
 * workspace's own library document declares (ADR-0034 decision 4).
 *
 * Read from the keeper's files source, as `useTagVocabulary` reads the tag
 * library, and ONCE per source: the library changes when someone edits the
 * `stencils` document, which is rare, and a session that has not re-read
 * offers the vocabulary it started with. A source that cannot answer, or a
 * read that fails, leaves the bundled registry — the panel then offers the
 * deployment's stencils, as it did before a library existed.
 */
import { type FacetRegistry, withWorkspaceStencils } from '@kamiazya/whiteboard-facet-engine'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import { useEffect, useState } from 'react'
import type { WorkspaceFilesSource } from '../lib/files-source.js'

async function stencilRegistryFor(
  source: Pick<WorkspaceFilesSource, 'readStencilLibrary'>,
): Promise<FacetRegistry> {
  const library = (await source.readStencilLibrary?.()) ?? {}
  return withWorkspaceStencils(bundledFacetRegistry, library)
}

export function useStencilRegistry(source: WorkspaceFilesSource | null): FacetRegistry {
  const [registry, setRegistry] = useState<FacetRegistry>(bundledFacetRegistry)
  useEffect(() => {
    if (source === null) {
      setRegistry(bundledFacetRegistry)
      return
    }
    let cancelled = false
    stencilRegistryFor(source).then(
      (next) => {
        if (!cancelled) setRegistry(next)
      },
      () => {
        if (!cancelled) setRegistry(bundledFacetRegistry)
      },
    )
    return () => {
      cancelled = true
    }
  }, [source])
  return registry
}
