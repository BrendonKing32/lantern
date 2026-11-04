export interface ProjectSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  chapter_count: number;
  word_count: number;
}

export type BibleKind = "character" | "place" | "thing" | "note";
export const BIBLE_KINDS: BibleKind[] = ["character", "place", "thing", "note"];

export interface BibleEntry {
  id: string;
  project_id: string;
  kind: BibleKind;
  name: string;
  aliases: string[];
  body: string;
  created_at: string;
  updated_at: string;
}

/** An AI-suggested Bible entry, shown for author review before it is saved. */
export interface BibleEntryDraft {
  name: string;
  kind: BibleKind;
  aliases: string[];
  body: string;
  source_quote: string;
  rationale: string;
  model: string;
  cost_usd: number;
}

export interface DeletedProject {
  id: string;
  title: string;
  deleted_at: string;
  chapter_count: number;
  word_count: number;
}

export interface DeletedChapter {
  id: string;
  title: string;
  word_count: number;
  deleted_at: string;
}

export interface ChapterMeta {
  id: string;
  project_id: string;
  title: string;
  synopsis: string;
  position: number;
  word_count: number;
  version: number;
  updated_at: string;
}

/** The English a novel is written in, for grammar and spelling checks. */
export const DIALECTS = [
  { id: "american", name: "US English" },
  { id: "british", name: "UK English" },
] as const;
export type Dialect = (typeof DIALECTS)[number]["id"];

export interface ProjectInfo {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  target_words: number | null;
  target_date: string | null;
  dialect: Dialect;
}

export interface ProjectDetail {
  project: ProjectInfo;
  chapters: ChapterMeta[];
}

export interface ChapterWithContent extends ChapterMeta {
  content: string;
}

export interface SaveResult {
  version: number;
  word_count: number;
  updated_at: string;
  /** Net words written today across every novel, after this save. */
  today_words?: number;
}

export interface DayWords {
  day: string; // YYYY-MM-DD, the writer's local date
  words: number;
}

export interface Stats {
  daily_goal: number | null;
  today: number;
  /** Consecutive days meeting the goal (or writing anything, with no goal), counting today once it's met. */
  streak: number;
  best_streak: number;
  /** Every day with writing in the last 12 weeks, oldest first. */
  days: DayWords[];
}

export type SnapshotReason = "auto" | "restore" | "conflict";

export interface Snapshot {
  id: string;
  version: number;
  word_count: number;
  reason: SnapshotReason;
  created_at: string;
}

export interface SnapshotWithContent extends Snapshot {
  content: string;
}

export interface AiCall {
  id: string;
  purpose: string;
  model: string;
  status: "pending" | "done" | "failed" | "unknown";
  input_tokens: number;
  output_tokens: number;
  /** Estimated; for a call that may or may not have been billed, the most it could have cost. */
  cost_usd: number;
  error: string | null;
  created_at: string;
}

export interface AiStatus {
  configured: boolean;
  model: string;
  daily_limit: number;
  used_last_24h: number;
  monthly_budget_usd: number;
  spent_this_month_usd: number;
  recent: AiCall[];
}

export type FindingKind = "contradiction" | "internal" | "new_fact";

export interface Finding {
  kind: FindingKind;
  /** A short passage copied exactly from the chapter. */
  quote: string;
  /** The bible entry involved, or "" if none. */
  entry: string;
  explanation: string;
  /** A possible fix, or "" if none. */
  suggestion: string;
}

export interface CheckResult {
  summary: string;
  findings: Finding[];
  /** Names of the bible entries that were sent with the chapter. */
  entries_checked: string[];
  model: string;
  cost_usd: number;
  checked_at: string;
}

export type BookFindingKind = "contradiction" | "timeline" | "bible";

export interface BookFinding {
  kind: BookFindingKind;
  /** The chapter the quote comes from. */
  chapter_id: string;
  chapter_title: string;
  /** A short passage copied exactly from that chapter. */
  quote: string;
  /** What it conflicts with, e.g. "Chapter 3" or "Bible: Mara". */
  conflicts_with: string;
  explanation: string;
  suggestion: string;
}

export interface BookCheckResult {
  summary: string;
  findings: BookFinding[];
  chapters_checked: number;
  words_checked: number;
  entries_checked: number;
  model: string;
  cost_usd: number;
  checked_at: string;
}

/** One line of the streamed reply to a whole-book check. */
export type BookCheckEvent =
  | { type: "started"; reserved_usd: number; chapters: number; words: number }
  | { type: "progress"; seconds: number }
  | { type: "result"; result: BookCheckResult }
  | { type: "error"; status: number; code: string; error: string };
