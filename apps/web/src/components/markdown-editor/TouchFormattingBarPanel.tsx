import { Ellipsis } from 'lucide-react'
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { TOGGLE_STATE_CLASS } from '../../components/ui/dock-button.js'
import { trackKeyboardDock } from '../../lib/software-keyboard.js'
import { cn } from '../../lib/utils.js'
import { DOCK_BUTTON_CLASS } from '../ui/dock-button.js'
import { useActiveMarkdownEditor } from './active-markdown-editor.js'
import {
  cycleHeadingLevel,
  type MarkdownVerbId,
  selfContainedCommand,
  VERB_BAR_ORDER,
  verb,
} from './editor-verbs.js'
import { layoutVerbBar, TOUCH_BAR_HEIGHT_PX, TOUCH_BAR_METRICS } from './verb-bar-layout.js'
import { VERB_ICONS } from './verb-icons.js'

const BAR_ITEMS = VERB_BAR_ORDER.map((id) => ({ id, band: verb(id).band }))

function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const update = () => setWidth(window.innerWidth)
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  return width
}

/**
 * The formatting bar's heavy half — verbs, icons, the overflow sheet —
 * loaded by `TouchFormattingBar` only once a phone actually needs it. It
 * carries the CodeMirror command table and the icon set, which is exactly
 * what must stay out of the entry chunk: the critical-path bundle budget
 * measured the eager version at +20 KB gzip.
 *
 * Slots follow the dock's button language and `VERB_BAR_ORDER`; what the
 * width cannot hold goes behind "…", a sheet above the bar (`layoutVerbBar`
 * decides the split). Every press cancels pointerdown so focus — and with
 * it the keyboard, and the node editor's blur-commit — stays put.
 */
export default function TouchFormattingBarPanel() {
  const editor = useActiveMarkdownEditor()
  const width = useWindowWidth()
  const [sheetOpen, setSheetOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // The strip's own position and visibility, written per frame and outside
  // React — see `trackKeyboardDock` for why neither half of that is
  // optional, and for why a strip that cannot keep up steps aside instead.
  const hasEditor = editor !== null
  useLayoutEffect(() => {
    const root = rootRef.current
    if (root === null) return
    return trackKeyboardDock(({ liftPx, settled }) => {
      root.style.transform = `translate3d(0, ${-liftPx}px, 0)`
      root.style.opacity = settled ? '1' : '0'
      root.style.pointerEvents = settled ? '' : 'none'
    })
  }, [hasEditor])

  useEffect(() => {
    if (!sheetOpen) return
    const close = (event: PointerEvent) => {
      const root = rootRef.current
      if (root !== null && event.composedPath().includes(root)) return
      setSheetOpen(false)
    }
    document.addEventListener('pointerdown', close, true)
    return () => document.removeEventListener('pointerdown', close, true)
  }, [sheetOpen])

  // The shell gates on these; between its decision and this render an editor can still blur.
  if (editor === null) return null

  const keepEditorFocus = (event: ReactPointerEvent) => {
    event.preventDefault()
  }
  const runVerb = (id: MarkdownVerbId) => {
    const spec = verb(id)
    if (spec.action.kind === 'levels') {
      editor.run(cycleHeadingLevel)
    } else if (spec.action.kind === 'interactive' && editor.openLinkPicker?.() === true) {
      // The host opened its picker; the wrap fallback is not wanted.
    } else {
      const command = selfContainedCommand(spec)
      if (command !== null) editor.run(command)
    }
    setSheetOpen(false)
  }
  const layout = layoutVerbBar(width, BAR_ITEMS, TOUCH_BAR_METRICS)

  return createPortal(
    <div
      ref={rootRef}
      data-testid="touch-formatting-bar"
      role="toolbar"
      aria-label="Formatting"
      className="bg-background border-border fixed inset-x-0 bottom-0 z-40 flex items-center border-t px-1 transition-opacity duration-150 select-none"
      style={{ height: TOUCH_BAR_HEIGHT_PX }}
      onPointerDown={keepEditorFocus}
    >
      {layout.visible.map((id, index) => {
        const spec = verb(id)
        const previous = index > 0 ? verb(layout.visible[index - 1]) : undefined
        return (
          <div key={id} className="flex items-center">
            {previous !== undefined && previous.band !== spec.band && (
              <span aria-hidden="true" className="bg-border mx-[3px] h-5 w-px" />
            )}
            <button
              type="button"
              aria-label={spec.label}
              title={spec.label}
              onClick={() => runVerb(id)}
              className={DOCK_BUTTON_CLASS}
            >
              {VERB_ICONS[id]}
            </button>
          </div>
        )
      })}
      {layout.overflow.length > 0 && (
        <>
          {layout.visible.length > 0 && (
            <span aria-hidden="true" className="bg-border mx-[3px] h-5 w-px" />
          )}
          <button
            type="button"
            aria-label="More formatting"
            title="More formatting"
            aria-haspopup="menu"
            aria-expanded={sheetOpen}
            onClick={() => setSheetOpen((open) => !open)}
            className={cn(DOCK_BUTTON_CLASS, TOGGLE_STATE_CLASS)}
          >
            <Ellipsis aria-hidden className="size-4" />
          </button>
          {sheetOpen && (
            <div
              role="menu"
              aria-label="More formatting"
              data-testid="touch-formatting-sheet"
              className="bg-background border-border absolute inset-x-2 bottom-full mb-2 grid grid-cols-4 gap-1 rounded-lg border p-2 shadow-md"
            >
              {layout.overflow.map((id) => {
                const spec = verb(id)
                return (
                  <button
                    key={id}
                    type="button"
                    role="menuitem"
                    aria-label={spec.label}
                    onClick={() => runVerb(id)}
                    className="text-muted-foreground hover:bg-accent hover:text-foreground flex h-16 flex-col items-center justify-center gap-1.5 rounded-md text-[11px] leading-none"
                  >
                    {VERB_ICONS[id]}
                    <span>{spec.label}</span>
                  </button>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>,
    document.body,
  )
}
