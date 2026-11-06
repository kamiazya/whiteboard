/**
 * What a screen reader hears when a comment write lands, on every surface
 * that writes one — the comments panel and the canvas card, menu and
 * compose bubble alike — so a note and a canvas say the same words for the
 * same act. The box that held focus is gone after the commit and a new row
 * or pin is not announced by being drawn, so the live region is the only
 * place the outcome exists for that reader.
 */
export const COMMENT_ANNOUNCEMENTS = {
  posted: 'Comment posted',
  replied: 'Reply sent',
  resolved: 'Conversation resolved',
  reopened: 'Conversation reopened',
} as const
