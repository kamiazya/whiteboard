/**
 * Width a row's markdown is laid out at, by the outline that draws its
 * miniature and by the render that draws its picture. Fixed rather than
 * measured: a row has no pane, and a shape that changed with the window would
 * make the same document look different on two screens.
 *
 * One value because the two lay the SAME document out: a width each file
 * picked for itself would let the miniature and the picture disagree about
 * where its lines break.
 */
export const ROW_LAYOUT_WIDTH = 640
