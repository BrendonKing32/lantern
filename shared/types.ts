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

export interface ProjectDetail {
  project: { id: string; title: string; created_at: string; updated_at: string };
  chapters: ChapterMeta[];
}

export interface ChapterWithContent extends ChapterMeta {
  content: string;
}

export interface SaveResult {
  version: number;
  word_count: number;
  updated_at: string;
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
