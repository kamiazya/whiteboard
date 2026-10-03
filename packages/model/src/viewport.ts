/**
 * The zoom range a canvas editor can show. Declared here, below both the
 * editor that clamps to it and the contract that bounds a caller's request,
 * so a request the schema accepts is one the editor can honour: the screen
 * to canvas transform divides by zoom, so 0 turns every coordinate into
 * NaN and a negative zoom mirrors the board.
 */
export const MIN_VIEWPORT_ZOOM = 0.1
export const MAX_VIEWPORT_ZOOM = 10
