/**
 * On a phone the document row must keep its act menu on screen.
 *
 * The row is back, title, then a shrink-0 cluster of the inspect members and
 * the ⋮ menu. At the coarse 44px control size five members plus the rest
 * came to more than a 390px screen, so the cluster's tail — the menu — was
 * laid out past the right edge, clipped and not scrollable.
 *
 * The runner emulates no `pointer: coarse`, so the coarse control size is
 * injected as an override derived from the class that declares it.
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import '../../index.css'
import { INSPECTOR_CHROME, INSPECTOR_ORDER } from '../../lib/inspector.js'
import { controlHeightsPx } from '../../test-utils/control-heights-px.js'
import { setViewport } from '../../test-utils/viewport.js'
import { DocumentProperties } from '../document-properties/DocumentProperties.js'
import { HEADER_BUTTON_CLASS } from '../ui/header-button.js'
import { DocumentMenu } from '../workspace-top-bar/DocumentMenu.js'
import { InspectorSegment } from './InspectorSegment.js'

const PHONE_WIDTH = 390
const { coarse } = controlHeightsPx(HEADER_BUTTON_CLASS)

beforeEach(async () => {
  await setViewport(PHONE_WIDTH, 844)
})
afterEach(async () => {
  cleanup()
  await setViewport(1280, 900)
})

function renderRow(onToggle: (kind: string) => void = () => {}) {
  return render(
    <>
      <style>{`header button { width: ${coarse}px; min-width: ${coarse}px; height: ${coarse}px; }`}</style>
      <header className="relative flex h-12 w-full shrink-0 items-center gap-3 border-b bg-background px-chrome">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <button type="button" aria-label="Back to documents" className={HEADER_BUTTON_CLASS} />
          <DocumentProperties
            inline
            title="A fairly long document title"
            actions={
              <>
                <InspectorSegment
                  open={null}
                  onToggle={onToggle}
                  tabs={{
                    properties: {},
                    comments: { count: 2 },
                    proposals: { count: 0 },
                    connections: { count: 3 },
                    history: {},
                  }}
                />
                <span aria-hidden="true" className="bg-border mx-1.5 h-4 w-px shrink-0" />
                <DocumentMenu onExport={() => {}} onBookmark={() => {}} />
              </>
            }
          />
        </div>
      </header>
    </>,
  )
}

describe('document row on a phone', () => {
  it('keeps More actions inside the viewport', () => {
    renderRow()
    const rect = screen.getByRole('button', { name: 'More actions' }).getBoundingClientRect()
    expect(rect.right).toBeLessThanOrEqual(PHONE_WIDTH)
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(PHONE_WIDTH)
  })

  it('still reaches every inspector surface by name', async () => {
    const toggled: string[] = []
    renderRow((kind) => toggled.push(kind))
    await userEvent.click(screen.getByRole('button', { name: 'Inspect this document' }))
    const menu = await screen.findByRole('menu')
    for (const kind of INSPECTOR_ORDER) {
      if (kind === 'display') continue
      expect(
        within(menu).getByRole('menuitem', {
          name: new RegExp(`^${INSPECTOR_CHROME[kind].label}`),
        }),
      ).toBeTruthy()
    }
    await userEvent.click(within(menu).getByRole('menuitem', { name: /^History/ }))
    expect(toggled).toEqual(['history'])
  })
})
