import { z } from 'zod'

/**
 * The words a person or an agent gives a saved version.
 *
 * One definition so the MCP tool and the daemon's REST save refuse the same
 * labels. The ceiling is not a display concern: a version's label is held in
 * every listing of the document's history, so an unbounded one is re-sent on
 * every read of the History panel and `wb_version_list` for as long as the
 * version lives.
 */
export const versionLabelSchema = z.string().min(1).max(200)
