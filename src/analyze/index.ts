export {
  categorize,
  classifyCommand,
  commandBreakdown,
  type BashCall,
  type CommandStat,
} from "./commands.js";
export {
  classifyRegen,
  detectRegenerations,
  type RegenOptions,
  type RegenPoint,
  type RegenResult,
  type RegenSeverity,
} from "./cache-regen.js";
export {
  classifyPrefixTransition,
  analyzePrefixStability,
  summarizePrefixStability,
  type PrefixInput,
  type PrefixTransition,
  type BrokenSegment,
  type PrefixStabilityResult,
  type PrefixStabilitySummary,
} from "./prefix-stability.js";
export {
  claudeProjectsDir,
  computeStats,
  locateTranscript,
  newestTranscriptFor,
  parseTranscript,
  projectSavings,
  projectSlug,
  toolResults,
  toolUseNames,
  type ParsedTranscript,
  type ReconstructedMessage,
  type SavingsProjection,
  type ToolResultInfo,
  type TranscriptEvent,
  type TranscriptStats,
  type TranscriptUsage,
} from "./claude-transcript.js";
export { detectSearchReadChains, type SearchReadChain } from "./search-read.js";
export {
  analyzeIdleGaps,
  type GapBucket,
  type IdleGapsResult,
  type SessionIdleGaps,
} from "./idle-gaps.js";
