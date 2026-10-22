import type { DragEvent } from 'react'
import { useCallback, useRef, useState } from 'react'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import type { ImportedDocument } from '../../lib/document-import.js'
import { importPathIn, readImportedFile } from '../../lib/document-import.js'
import type { WorkspaceFilesSource } from '../../lib/files-source.js'

export interface ImportReport {
  readonly tone: 'info' | 'error'
  readonly messages: readonly string[]
}

interface UseImportFilesOptions {
  readonly source: Pick<WorkspaceFilesSource, 'importDocument'>
  /** The folder the files land in. */
  readonly folder: string
  /** Every document the workspace holds, so a name already taken is suffixed. */
  readonly documents: readonly { readonly path: string }[] | null
  readonly refreshAndSelect: (path: string) => Promise<WorkspaceDocumentEntry | null>
  readonly openPath: (path: string, entry: WorkspaceDocumentEntry | null) => void
}

function messageOf(err: unknown): string {
  return err instanceof Error && err.message !== '' ? err.message : 'the write was refused'
}

/** A file's text; an unreadable one reads as empty and is refused by the parser's own reason. */
async function textOf(file: File): Promise<string> {
  try {
    return new TextDecoder().decode(await file.arrayBuffer())
  } catch {
    return ''
  }
}

type ImportOutcome = { readonly path: string } | { readonly failure: string }

/** One file, read and written; a refusal is the outcome, never a throw. */
async function importOne(
  file: File,
  folder: string,
  taken: string[],
  importDocument: (path: string, document: ImportedDocument) => Promise<void>,
): Promise<ImportOutcome> {
  const read = readImportedFile(file.name, await textOf(file))
  if (!read.ok) return { failure: read.reason }
  const path = importPathIn(folder, read.document.pathBase, taken)
  try {
    await importDocument(path, read.document)
  } catch (err) {
    return { failure: `${file.name} could not be imported: ${messageOf(err)}` }
  }
  taken.push(path)
  return { path }
}

/** Refreshes the list to show what arrived, and words the report. */
async function settle(
  outcomes: readonly ImportOutcome[],
  refreshAndSelect: UseImportFilesOptions['refreshAndSelect'],
  openPath: UseImportFilesOptions['openPath'],
): Promise<ImportReport> {
  const created = outcomes.flatMap((outcome) => ('path' in outcome ? [outcome.path] : []))
  const failures = outcomes.flatMap((outcome) => ('failure' in outcome ? [outcome.failure] : []))
  const last = created.at(-1)
  if (last !== undefined) {
    try {
      const entry = await refreshAndSelect(last)
      if (created.length === 1 && failures.length === 0) openPath(last, entry)
    } catch {
      failures.push('The list could not be refreshed. Reload to see what was imported.')
    }
  }
  if (failures.length > 0) return { tone: 'error', messages: failures }
  return {
    tone: 'info',
    messages: [`Imported ${created.length} ${created.length === 1 ? 'document' : 'documents'}`],
  }
}

function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files')
}

type DropHandlers = Record<
  'onDragOver' | 'onDragEnter' | 'onDragLeave' | 'onDrop',
  (event: DragEvent) => void
>

/**
 * Always stops the browser's default for a dropped file, which is to
 * navigate away from the app to it — whether or not the file is importable.
 */
function useDropProps(
  importFiles: (files: readonly File[]) => Promise<void>,
  canImport: boolean,
  setDragging: (dragging: boolean) => void,
  setReport: (report: ImportReport) => void,
): DropHandlers {
  return {
    onDragOver: (event) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    },
    onDragEnter: (event) => {
      if (carriesFiles(event)) setDragging(true)
    },
    onDragLeave: (event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
    },
    onDrop: (event) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      setDragging(false)
      const files = Array.from(event.dataTransfer.files)
      if (!canImport) {
        setReport({ tone: 'error', messages: ['This workspace cannot import files.'] })
        return
      }
      void importFiles(files)
    },
  }
}

/**
 * Bringing files in as documents: the picker's files and a drop share one
 * path, so a refusal reads the same wherever the file came from.
 *
 * A file is read, parsed by the codec's total parsers and written one at a
 * time; one that fails is reported by name and does not stop the rest. A lone
 * success opens, as a create does; several leave the last selected, since
 * opening one would hide that the others arrived.
 */
export function useImportFiles({
  source,
  folder,
  documents,
  refreshAndSelect,
  openPath,
}: UseImportFilesOptions) {
  const [report, setReport] = useState<ImportReport | null>(null)
  const [importing, setImporting] = useState(false)
  const [dragging, setDragging] = useState(false)
  const pathsRef = useRef<readonly string[]>([])
  pathsRef.current = (documents ?? []).map((row) => row.path)
  const importDocument = source.importDocument?.bind(source)

  const importFiles = useCallback(
    async (files: readonly File[]) => {
      if (importDocument === undefined || files.length === 0) return
      setReport(null)
      setImporting(true)
      try {
        const taken = [...pathsRef.current]
        const outcomes: ImportOutcome[] = []
        for (const file of files) {
          outcomes.push(await importOne(file, folder, taken, importDocument))
        }
        setReport(await settle(outcomes, refreshAndSelect, openPath))
      } finally {
        setImporting(false)
      }
    },
    [importDocument, folder, refreshAndSelect, openPath],
  )

  const dropProps = useDropProps(importFiles, importDocument !== undefined, setDragging, setReport)

  return {
    importFiles: importDocument === undefined ? undefined : importFiles,
    importing,
    dragging,
    report,
    dismissReport: () => setReport(null),
    dropProps,
  }
}

/** What the last import did, in the place the panel reports its other writes. */
export function ImportReportLine({ report }: { report: ImportReport | null }) {
  if (report === null) return null
  return report.tone === 'error' ? (
    <div role="alert" className="text-destructive text-sm">
      {report.messages.map((message) => (
        <p key={message}>{message}</p>
      ))}
    </div>
  ) : (
    <p role="status" className="text-muted-foreground text-sm">
      {report.messages.join(' ')}
    </p>
  )
}
