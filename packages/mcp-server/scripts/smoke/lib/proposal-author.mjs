/** What the propose tools are given as `author`, and must answer back. */
export const SMOKE_AUTHOR = 'e2e-smoke/1.0'

/**
 * A proposal stores the author the caller named. Through a real MCP client the
 * SDK has already parsed `proposed` against `proposalSchema`, so a tool that
 * accepted the field and never forwarded it shows up here as an absent one.
 */
export function assertProposalAuthor(tool, result) {
  if (result.proposed?.author !== SMOKE_AUTHOR) {
    throw new Error(`${tool} dropped the author it was given: ${JSON.stringify(result.proposed)}`)
  }
}
