import {
  type OkfMarkdownDocument,
  OkfNotYamlSafeError,
  parseOkf,
  serializeOkf,
} from '@kamiazya/whiteboard-codec'
import {
  readDocumentKind,
  readMarkdownBody,
  readSpatialCanvas,
  readTrustFacets,
  MARKDOWN_BODY_NODE_ID as TEXT_NODE_ID,
  writeCoreFacets,
  writeDocumentKind,
  writeFacets,
  writeMarkdownBody,
  writeTrustFacets,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  documentIdSchema,
  EXTENSION_FACET_KEY_PATTERN,
  type ExtensionFacets,
  markdownInputSchema,
  okfActorSchema,
  tagWriteSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
import type { LoroDoc } from 'loro-crdt'
import { z } from 'zod'
import { loadOrCreateDocument, saveDocumentSnapshot } from '../document-io.js'
import type { ServerDeps } from '../server-deps.js'
import { assertDocumentInWorkspace } from './assert-document-in-workspace.js'
import { DocumentContentLossError, DocumentKindMismatchError } from './errors.js'
import { partitionFacetWrites, registryForFacetWrites } from './facet-write.js'
import { refuseUnusableStencilLibrary } from './stencil-library.js'
import { refuseFrontmatterTags } from './tag-library.js'

/**
 * Whether a canvas is one this tool could itself have written, and so holds
 * nothing a markdown write would destroy.
 *
 * A markdown document written today has an empty canvas — the body is a
 * CRDT text container. One written by the older writer stored the body as a
 * single `okf-body` text node, which made it ALSO a valid one-node spatial
 * canvas, so "has any node" cannot tell such a document from a diagram.
 * Accepting that legacy shape as well keeps documents that predate both the
 * container and kinds editable, without letting a real diagram through.
 */
function isMarkdownShaped(canvas: { nodes: readonly { id: string }[]; edges: readonly unknown[] }) {
  if (canvas.edges.length > 0) return false
  return (
    canvas.nodes.length === 0 || (canvas.nodes.length === 1 && canvas.nodes[0]?.id === TEXT_NODE_ID)
  )
}

export const documentSetInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    documentId: documentIdSchema,
    markdown: markdownInputSchema,
    /**
     * Who is producing this content, in OKF's actor convention (§7):
     * `<producer>/<version>` for an agent or tool, `human:<id>` for a
     * person, `process:<id>` for an automated process.
     *
     * Declared rather than inferred, because there is nothing here to infer
     * it from: `/mcp` builds a fresh server per request, so the `clientInfo`
     * from `initialize` never reaches a tool call, and local-daemon mode
     * authenticates every client on the machine with one shared token
     * (ADR-0016). OKF puts the obligation on the producer for the same
     * reason — trust tiers are advisory signals, not access control (§5.3).
     */
    actor: okfActorSchema.optional(),
  })
  .strict()
export type DocumentSetInput = z.infer<typeof documentSetInputSchema>

const documentSetOutputSchema = z
  .object({
    documentId: documentIdSchema,
    imported: z.literal(true),
  })
  .strict()
export type DocumentSetOutput = z.infer<typeof documentSetOutputSchema>

/**
 * What `generated.by` says when the client did not identify itself. OKF
 * requires `by` inside `generated` (§5.2), so a stamp has to name someone —
 * and the honest answer is the server the write came through, not a guess at
 * which agent was driving. `process:<id>` is §7's form for exactly this.
 */
const UNATTRIBUTED_ACTOR = 'process:whiteboard-server'

/**
 * The field-level detail a schema-stage failure already carries, rendered
 * into the sentence a caller reads.
 *
 * `CodecParseError.issues` has said since it was written that it exists "so
 * a caller can render field-level detail", and for as long as it has said so
 * both call sites passed only the stage and the message — leaving a caller
 * told "frontmatter failed OKF schema validation" while the key that failed
 * sat one field away. Measured in three of the eval lane's trials, each
 * paying a retry.
 *
 * BOUNDED at three: a deeply malformed payload can raise dozens, and a wall
 * of them is as unreadable as none. The count is stated when it is cut so a
 * caller knows the list is not the whole of it.
 */
function detail(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  if (issues.length === 0) return ''
  const named = issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.map(String).join('.')
      return path === '' ? issue.message : `${path}: ${issue.message}`
    })
    .join('; ')
  const rest = issues.length - 3
  return ` — ${named}${rest > 0 ? ` (and ${rest} more)` : ''}`
}

/** The stage a write is refused at when its frontmatter holds a value YAML cannot carry. */
export const OKF_YAML_SAFE_STAGE = 'frontmatter-yaml-safe'

/** The stage a write is refused at when a frontmatter tag breaks ADR-0040's write grammar. */
const OKF_TAGS_STAGE = 'frontmatter-tags'

/** The stage a write is refused at when a facet key sits at the frontmatter root. */
const OKF_ROOT_FACET_STAGE = 'frontmatter-facets'

const writableTagsSchema = z.array(tagWriteSchema)

export class OkfParseError extends Error {
  constructor(
    public readonly stage: string,
    message: string,
    issues: readonly { path: PropertyKey[]; message: string }[] = [],
  ) {
    super(`OKF parse failed at ${stage}: ${message}${detail(issues)}`)
    this.name = 'OkfParseError'
  }
}

/**
 * Parses OKF for a WRITE: the document it returns is one the read side can
 * write back out.
 *
 * A value YAML has no representation for (`.nan`, `.inf`) parses, is stored,
 * and then fails every read of the document — so the write is the place to
 * say so, with the key named, while the caller still holds the content.
 * `serializeOkf` is the one definition of what can be written out, so this
 * asks it rather than restating its rule.
 *
 * Frontmatter `tags` are held to the scoped-tag write grammar here, where both
 * body writers (`document.set`, `document.create`'s preflight before its
 * mint) already share one parse: a colon-bearing tag that is not `key:value`
 * would otherwise be stored by a body while `wb_facet_set` and the editor
 * refuse it. Reading stays lenient — a stored tag is never re-judged.
 */
export function parseWritableOkf(markdown: string): OkfMarkdownDocument {
  const parsed = parseOkf(markdown)
  if (!parsed.ok) {
    throw new OkfParseError(parsed.error.stage, parsed.error.message, parsed.error.issues)
  }
  try {
    serializeOkf(parsed.value)
  } catch (error) {
    // Only the not-yaml-safe refusal is the caller's to fix; any other throw
    // is a defect in the serialiser and keeps its own name.
    if (!(error instanceof OkfNotYamlSafeError)) throw error
    throw new OkfParseError(
      OKF_YAML_SAFE_STAGE,
      'frontmatter contains a value YAML cannot represent',
      error.issues,
    )
  }
  // A facet-spelled key at the root is preserved as an unknown key and read by
  // nothing: no plugin looks there, so the registry never validates it and the
  // facet it names has no effect, while the same payload under `facets:` is
  // checked. Refusing it says where the key belongs instead of storing a
  // silent no-op that a later `wb_facet_set` then writes a second copy of.
  const rootFacetKeys = Object.keys(parsed.value.frontmatter.facetsRaw ?? {}).filter((key) =>
    EXTENSION_FACET_KEY_PATTERN.test(key),
  )
  if (rootFacetKeys.length > 0) {
    const quoted = rootFacetKeys.map((key) => JSON.stringify(key)).join(', ')
    throw new OkfParseError(
      OKF_ROOT_FACET_STAGE,
      `${quoted} at the root of the frontmatter look like facet keys, which are only read under \`facets:\` — move them there`,
    )
  }
  const tags = writableTagsSchema.safeParse(parsed.value.frontmatter.tags ?? [])
  if (!tags.success) {
    throw new OkfParseError(
      OKF_TAGS_STAGE,
      'frontmatter tags are refused',
      tags.error.issues.map((issue) => ({ ...issue, path: ['tags', ...issue.path] })),
    )
  }
  return parsed.value
}

/**
 * The frontmatter's `facets` bucket as it is stored, refused if a registered
 * facet in it, or a stencil library it carries, is one `wb_facet_set` would
 * refuse for a document (ADR-0013 decisions 6 and 10).
 *
 * A body is the other way to write a facet — the same payload as YAML instead
 * of as a tool argument — so it is held to the same registry rule, before the
 * document is opened. `document.create` runs it in its preflight too, for
 * the reason it runs the tag check there: the delegated write would otherwise
 * refuse AFTER the mint and leave an empty document squatting the path.
 */
export async function checkFrontmatterFacets(
  deps: ServerDeps,
  workspaceId: string,
  facets: ExtensionFacets | undefined,
): Promise<ExtensionFacets | undefined> {
  if (facets === undefined) return undefined
  const registry = await registryForFacetWrites(deps, workspaceId, [facets])
  // The sent bucket with each registered payload replaced by its parsed
  // value: a body is a whole-document import, so what the caller wrote and the
  // schema has no opinion on (an unregistered facet) round-trips as it came.
  const { sets } = partitionFacetWrites(registry, facets, 'document')
  // A stencil library is a facet whose payload only means something once it is
  // composed with the deployment's registry, and `wb_facet_set` refuses an
  // unusable one for the same reason this body must.
  refuseUnusableStencilLibrary(deps, sets)
  return { ...facets, ...sets }
}

/**
 * Whether a `generated` the caller sent is foreign provenance to preserve,
 * rather than this server's own stamp echoed back by an edit.
 *
 * The distinction is needed because `document.set` replaces the ENTIRE
 * content, so an agent changing one paragraph must read the document first —
 * and the read hands back the `generated` block this server wrote. Honouring
 * a declared `generated` unconditionally therefore freezes the stamp at the
 * first write, and every later edit by any actor keeps it. That is not a lost
 * signal but a false one, and it defeats the reason decision 2 gives for the
 * server owning the clock: `generated.at` is what a consumer uses to tell a
 * recent edit from a stale fact.
 *
 * Two conditions, and both are load-bearing:
 *
 * - The declared stamp must differ from the stored one. A stamp this server
 *   did not write is someone else's account of how the content was produced,
 *   and the import case decision 2 protects depends on it surviving.
 * - The body must have changed. A rewrite that changes nothing is not an
 *   origin event, so re-importing the same bundle twice does not lose its
 *   provenance to the second import.
 *
 * The BODY is the comparison, not the frontmatter: §5.2 says `generated`
 * records how the current CONTENT was produced, and for a markdown document
 * that is the body — a metadata-only edit must not claim the content was
 * regenerated.
 */
function keepsDeclaredGenerated(
  declared: { by: string; at: string } | undefined,
  stored: { by: string; at: string } | undefined,
  storedBody: string | undefined,
  nextBody: string,
): boolean {
  if (declared === undefined) return false
  const echoesOurStamp =
    stored !== undefined && stored.by === declared.by && stored.at === declared.at
  if (!echoesOurStamp) return true
  return storedBody === nextBody
}

/**
 * Claim an unkinded document as markdown, and refuse a spatial one.
 *
 * This writes OKF Markdown, which replaces the whole spatial canvas — on a
 * spatial document that is a destruction rather than an edit. A document with
 * NO kind predates them: the write is the only thing that can give it one, and
 * refusing would leave it with no way back (ADR-0009 decision 4) — but only a
 * document already in markdown's own shape has nothing to lose by being
 * declared markdown. One holding a canvas gets its way back from the spatial
 * side, which declares a kind without discarding anything.
 */
function claimMarkdownDocument(doc: LoroDoc, documentId: string): void {
  const kind = readDocumentKind(doc)
  if (kind === undefined) {
    const existing = readSpatialCanvas(doc)
    if (!isMarkdownShaped(existing)) {
      throw new DocumentContentLossError(
        documentId,
        `It holds ${existing.nodes.length} node(s) and ${existing.edges.length} edge(s), which this write would replace with a single text node. ` +
          'Edit it through wb_canvas_edit, which records it as spatial and keeps them.',
      )
    }
    writeDocumentKind(doc, 'markdown')
    return
  }
  if (kind !== 'markdown') {
    throw new DocumentKindMismatchError(
      documentId,
      kind,
      'This writes OKF Markdown, which would replace its nodes and edges with a single text node. Edit a spatial document through wb_canvas_edit instead.',
    )
  }
}

/**
 * An OKF `title` lands on the WORKSPACE, not in the document.
 *
 * OKF is an export format, not the storage model: the Loro side keeps its own
 * OKF-compatible document and the workspace owns the name, so parsing projects
 * INTO that model exactly as serialising projects back out (ADR-0009 decision
 * 2). Absent is not cleared — an OKF with no title says nothing about the name
 * — while a BLANK one clears it, because a blank title is not a name and the
 * two are deliberately one state rather than a `''` a reader falls back from a
 * second time.
 */
async function applyOkfTitle(
  deps: ServerDeps,
  input: DocumentSetInput,
  title: string | undefined,
): Promise<void> {
  if (title === undefined) return
  const trimmed = title.trim()
  await deps.documentIndex.setDocumentName({
    workspaceId: input.workspaceId,
    documentId: input.documentId,
    ...(trimmed === '' ? {} : { name: trimmed }),
  })
}

export function createDocumentSetTool(deps: ServerDeps) {
  return {
    name: 'wb_document_set' as const,
    description:
      'Replace the entire content of an existing document from an OKF Markdown string. The document must already exist; core facets, extension facets and the body are all overwritten rather than merged. Pass `actor` to identify yourself — it is recorded as OKF `generated.by`, so a later reader can tell what wrote the document.',
    inputSchema: documentSetInputSchema,
    outputSchema: documentSetOutputSchema,
    execute: async (input: DocumentSetInput): Promise<DocumentSetOutput> => {
      await assertDocumentInWorkspace(deps.documentIndex, input.workspaceId, input.documentId)

      const { frontmatter, body } = parseWritableOkf(input.markdown)

      // What the workspace DECLARES about its tags reaches this writer too
      // (ADR-0040 decision 5) — taken before the document is opened, so a
      // refusal leaves the stored body as it stands.
      await refuseFrontmatterTags(deps, input.workspaceId, frontmatter.tags)
      const checkedFacets = await checkFrontmatterFacets(
        deps,
        input.workspaceId,
        frontmatter.facets,
      )

      const doc = await loadOrCreateDocument(deps, input.workspaceId, input.documentId)
      // Captured before anything below writes, because both are what the
      // document said a moment ago rather than what it is about to say.
      const storedTrust = readTrustFacets(doc)
      const storedBody = readMarkdownBody(doc)

      claimMarkdownDocument(doc, input.documentId)

      // OKF is an export format, not the storage model: the Loro side keeps
      // its own OKF-compatible document, and the workspace owns the name. So
      // parsing an OKF projects it INTO that model exactly as serialising
      // projects back out, and `title` lands on the workspace rather than
      // becoming a second stored copy (ADR-0009 decision 2).
      //
      // Absent is not cleared: an OKF with no `title` says nothing about the
      // name, so omitting it must not erase one.
      const { facets: _sent, title, generated, verified, ...coreFacets } = frontmatter
      await applyOkfTitle(deps, input, title)
      writeCoreFacets(doc, coreFacets)
      if (frontmatter.facets !== undefined) {
        writeFacets(doc, checkedFacets ?? {})
      }

      // A `generated` the document already declares is the truth about how
      // that content was produced (§5.2) — importing it did not author it —
      // so it is honoured rather than restamped. Only content this write is
      // the origin of gets the server's clock (ADR-0016 decision 2).
      writeTrustFacets(doc, {
        generated: keepsDeclaredGenerated(generated, storedTrust?.generated, storedBody, body)
          ? (generated as NonNullable<typeof generated>)
          : {
              by: input.actor ?? UNATTRIBUTED_ACTOR,
              at: new Date().toISOString(),
            },
        ...(verified === undefined ? {} : { verified }),
      })

      // The body goes in the CRDT text container, and this clears the
      // spatial canvas with it (see writeMarkdownBody). Older documents
      // stored it as an `okf-body` TEXT NODE, which made every markdown
      // document also parse as a valid one-node canvas — the ambiguity that
      // forces every reference resolver to ask the document its kind before
      // it can tell prose from a diagram. Reads handle both shapes, so
      // stored documents need no migration; they converge as they are
      // rewritten.
      writeMarkdownBody(doc, body)

      await saveDocumentSnapshot(deps, input.workspaceId, input.documentId, doc)

      return { documentId: input.documentId, imported: true }
    },
  }
}
