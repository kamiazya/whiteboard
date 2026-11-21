// A test that mutates the workspace record as a `LoroDoc` (`getWorkspaceDoc`,
// `saveWorkspaceDoc`) holds records as one, which is the kind's own setting.
// Imported first, so the choice is made before the cache reads it.
process.env.WHITEBOARD_RECORD_KIND = 'loro'
