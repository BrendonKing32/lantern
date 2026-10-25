export interface ProjectSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  chapter_count: number;
  word_count: number;
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
