export interface ProjectSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  chapter_count: number;
  word_count: number;
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

export interface ProjectInfo {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  target_words: number | null;
  target_date: string | null;
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
