/**
 * The margin a note's picture is drawn with on every side, beyond its ink.
 *
 * Its own module because the list surfaces read it to crop a note's picture
 * to its ink, and importing it from the renderer would pull the whole
 * markdown pipeline into a chunk that only ever receives finished SVG.
 */
export const PREVIEW_PADDING_PX = 8
