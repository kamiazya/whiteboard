import { describe, expect, it, vi } from 'vitest'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { BinaryFileData, DataURL } from '@excalidraw/excalidraw/types'
import type { FileId } from '@excalidraw/excalidraw/element/types'

const { restoreElementsMock } = vi.hoisted(() => ({
  restoreElementsMock: vi.fn(),
}))

vi.mock('@excalidraw/excalidraw', () => ({
  exportToBlob: vi.fn(),
  CaptureUpdateAction: { NEVER: 'never' },
  restoreElements: restoreElementsMock,
}))

import { applyHydratedSceneToApi } from './useWhiteboardSync.js'

function makeElement(id: string): ExcalidrawElement {
  return { id } as unknown as ExcalidrawElement
}

function makeFile(id: string): BinaryFileData {
  return {
    id: id as FileId,
    mimeType: 'image/png',
    dataURL: 'data:image/png;base64,aaa' as DataURL,
    created: 1,
  }
}

describe('applyHydratedSceneToApi', () => {
  it('rehydrates legacy elements through restoreElements before updateScene', () => {
    const legacy = [makeElement('legacy-line')]
    const restored = [makeElement('restored-line')]
    restoreElementsMock.mockReturnValueOnce(restored)

    const api = {
      addFiles: vi.fn(),
      updateScene: vi.fn(),
    }

    applyHydratedSceneToApi({
      api,
      elements: legacy,
      files: [makeFile('file-1')],
    })

    expect(api.addFiles).toHaveBeenCalledWith([makeFile('file-1')])
    expect(restoreElementsMock).toHaveBeenCalledWith(legacy, null, {
      repairBindings: true,
    })
    expect(api.updateScene).toHaveBeenCalledWith({
      elements: restored,
      captureUpdate: 'never',
    })
  })
})
