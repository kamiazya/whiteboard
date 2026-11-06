import type { ComponentProps } from 'react'
import { createPortal } from 'react-dom'
import { ContextMenu } from '../ui/ContextMenu.js'

/**
 * How far below the screen's top a home-list sheet may reach. The sheet holds
 * itself to half its containing block — right for the canvas, where the
 * pressed object has to stay in view above it — so its host is made twice the
 * height the sheet may take, reaching up past the top of the screen. Nothing
 * on the list has to stay in view: the sheet is the whole question.
 */
const SHEET_TOP_GAP = '3rem'

/**
 * The panel's object menu. With a pointer it is the point-anchored list, in
 * panel coordinates. As a touch sheet it is lifted out of the panel into a
 * screen-fixed host: inside the panel it docked to the panel's inset bottom
 * edge, dimmed only the panel, and was capped at half the panel's height, so a
 * document's last actions (Rename…, Delete) sat below a fold nothing showed.
 */
export function PanelMenu(props: ComponentProps<typeof ContextMenu>) {
  if (props.variant !== 'sheet') return <ContextMenu {...props} />
  return createPortal(
    <div
      data-panel-sheet-host
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        height: `calc(200dvh - 2 * ${SHEET_TOP_GAP})`,
        zIndex: 50,
      }}
    >
      <ContextMenu {...props} />
    </div>,
    document.body,
  )
}
