export {
  BranchConflictError,
  BranchNotFoundError,
  type BranchOpResult,
  type BranchScope,
  type CreateBranchOptions,
  createBranch,
  deleteBranch,
  nextBranchColor,
  renameBranch,
  setHead,
  updateBranchTip,
} from './branches/ops.js'
export {
  BRANCHES_PLANE_KEY,
  readBranchesFromRecord,
  writeBranchesToRecord,
} from './branches/record-store.js'
export {
  type BranchMeta,
  branchMetaSchema,
  DEFAULT_MAIN_COLOR,
  type DocumentBranchesState,
  defaultMain,
  documentBranchesStateSchema,
  MAIN_BRANCH,
  resolveHead,
} from './branches/schema.js'
export {
  autoVersionsOverCap,
  type CapCandidate,
  MAX_AUTO_PER_DOCUMENT,
  type SandwichCandidate,
  sandwichedAutoVersionIds,
} from './checkpoints/retention.js'
export {
  CHECKPOINT_CEILING_MS,
  CHECKPOINT_QUIET_MS,
  type CheckpointScheduler,
  type CheckpointSchedulerOptions,
  createCheckpointScheduler,
} from './checkpoints/scheduler.js'
export {
  base64ToBytes,
  bytesToBase64,
  frontiersFromBase64,
  frontiersToBase64,
} from './frontiers-base64.js'
export {
  detectMergeBadges,
  type MergeBadge,
  meetVersion,
  toElementMap,
} from './merge/merge-engine.js'
export {
  type MergePlan,
  type MergePlanInput,
  planMerge,
  UnreadableBranchTipError,
} from './merge/plan-merge.js'
