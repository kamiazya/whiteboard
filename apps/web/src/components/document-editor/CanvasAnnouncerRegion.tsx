import { useSyncExternalStore } from 'react'
import { canvasAnnouncement, subscribeCanvasAnnouncement } from '../../lib/canvas-announcer.js'
import { AnnouncerRegion } from '../annotations/announcer.js'

/** Mounted with the editor, so it is in the page before the text it speaks. */
export function CanvasAnnouncerRegion() {
  const text = useSyncExternalStore(subscribeCanvasAnnouncement, canvasAnnouncement)
  return <AnnouncerRegion text={text} />
}
