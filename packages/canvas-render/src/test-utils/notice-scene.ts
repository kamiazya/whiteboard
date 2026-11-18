import type { Scene } from '@kamiazya/whiteboard-scene'
import { layoutNoticePicture } from '../core-picture.js'
import type { NoticeOptions } from '../layout/notice-switch.js'
import { type LayoutRefusal, refusalCopy } from '../refusal.js'
import { testLayoutCore } from './test-layout-core.js'

/**
 * The scene a surface owes a refused layout: the core's notice for
 * `refusalCopy`'s words, carrying the refusal. A switch test compares what it
 * drew against this, so it fails when the switch stops drawing the notice or
 * draws it with the wrong measurer, mode, width or place. The core's own notice
 * is held to `oracle/notice.jsonl` by `core-notice.rust.test.ts`.
 */
export function noticeSceneOf(refusal: LayoutRefusal, options: NoticeOptions): Scene {
  const { scene } = layoutNoticePicture(testLayoutCore(), refusalCopy(refusal), options, {})
  return { ...scene, refusal }
}
