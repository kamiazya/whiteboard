// MCP tool for searching the official libraries.excalidraw.com catalog. It lets
// clients discover a library by keyword and then install/insert it without
// knowing the raw URL ahead of time. Results are cached in memory for 10 minutes.

import { z } from 'zod'

// Mirrors the upstream CatalogEntry shape declared below: `id` may be omitted,
// and `authors` is an array of {name?, url?} objects.
export const libraryCatalogListOutputSchema = z.object({
  totalCount: z.number(),
  returnedCount: z.number(),
  items: z.array(
    z.object({
      id: z.string().optional(),
      name: z.string(),
      description: z.string().optional(),
      authors: z
        .array(z.object({ name: z.string().optional(), url: z.string().optional() }))
        .optional(),
      url: z.string(),
      previewUrl: z.string().optional(),
      created: z.string().optional(),
      updated: z.string().optional(),
    }),
  ),
})

const CATALOG_URL = 'https://libraries.excalidraw.com/libraries.json'
const CATALOG_BASE = 'https://libraries.excalidraw.com/libraries/'
const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes

interface CatalogEntry {
  id?: string
  name: string
  description?: string
  authors?: Array<{ name?: string; url?: string }>
  source: string
  preview?: string
  created?: string
  updated?: string
  version?: number
}

interface CatalogCache {
  fetchedAt: number
  entries: CatalogEntry[]
}

let cache: CatalogCache | null = null

// Test helper: reset the cache. Production relies on TTL expiry.
export function __resetCatalogCacheForTest(): void {
  cache = null
}

async function loadCatalog(): Promise<CatalogEntry[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.entries
  }
  const res = await fetch(CATALOG_URL)
  if (!res.ok) {
    throw new Error(`Failed to fetch library catalog: ${res.status}`)
  }
  const entries = (await res.json()) as CatalogEntry[]
  cache = { fetchedAt: Date.now(), entries }
  return entries
}

// Split query on whitespace and require every keyword to match somewhere in the
// name, description, or author names (case-insensitive AND matching).
function matchesQuery(entry: CatalogEntry, q: string): boolean {
  const keywords = q
    .toLowerCase()
    .split(/\s+/)
    .filter((k) => k.length > 0)
  if (keywords.length === 0) return true
  const haystack = [
    entry.name,
    entry.description ?? '',
    ...(entry.authors ?? []).map((a) => a.name ?? ''),
  ]
    .join('\n')
    .toLowerCase()
  return keywords.every((kw) => haystack.includes(kw))
}

export function libraryCatalogListTool() {
  return {
    name: 'library_catalog_list',
    description:
      'Search the official Excalidraw library catalog (libraries.excalidraw.com/libraries.json). Use this to discover .excalidrawlib bundles by keyword before calling library_install. Returns metadata (name, description, authors, absolute download URL, preview URL) for matching libraries.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Case-insensitive substring matched against name / description / author name. Omit to list all libraries.',
        },
        limit: {
          type: 'number',
          description: 'Cap the number of returned items. Default 20.',
        },
      },
    },
    execute: async (args: { query?: string; limit?: number }) => {
      const entries = await loadCatalog()
      const filtered = args.query
        ? entries.filter((e) => matchesQuery(e, args.query!))
        : entries
      const limit = args.limit ?? 20
      const sliced = filtered.slice(0, Math.max(0, limit))
      return {
        totalCount: filtered.length,
        returnedCount: sliced.length,
        items: sliced.map((e) => ({
          id: e.id,
          name: e.name,
          description: e.description,
          authors: e.authors,
          url: CATALOG_BASE + e.source,
          previewUrl: e.preview ? CATALOG_BASE + e.preview : undefined,
          created: e.created,
          updated: e.updated,
        })),
      }
    },
  }
}
