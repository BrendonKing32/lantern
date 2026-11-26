// The shapes the app expects back from the API, checked at runtime by api.ts.

import {
  BIBLE_KINDS,
  DIALECTS,
  type Act,
  type AiStatus,
  type BibleEntry,
  type BibleEntryDraft,
  type BookCheckEvent,
  type BookCheckResult,
  type ChapterMeta,
  type ChapterWithContent,
  type ClaudeChange,
  type ClaudeDraft,
  type CheckResult,
  type DeletedChapter,
  type DeletedProject,
  type Dialect,
  type MarginNote,
  type Outline,
  type Milestone,
  type MilestoneChapter,
  type ProjectDetail,
  type ProjectSummary,
  type SaveResult,
  type SceneMeta,
  type SceneListing,
  type ShareComment,
  type ShareLink,
  type SharedProject,
  type Snapshot,
  type SnapshotWithContent,
  type Stats,
} from "../shared/types";
import { array, boolean, type Check, literal, nullable, number, object, optional, ShapeError, string, tagged } from "./validate";

export const ok = object({ ok: literal(true) });

export const marginNote: Check<MarginNote> = object({
  id: string,
  project_id: string,
  chapter_id: string,
  quote: string,
  prefix: string,
  suffix: string,
  body: string,
  author: literal("writer", "claude"),
  resolved_at: nullable(string),
  created_at: string,
  updated_at: string,
});

export const projectSummary: Check<ProjectSummary> = object({
  id: string,
  title: string,
  created_at: string,
  updated_at: string,
  archived_at: nullable(string),
  chapter_count: number,
  word_count: number,
});

export const projectRef = object({ id: string, title: string });

export const milestone: Check<Milestone> = object({
  id: string, project_id: string, name: string, note: string,
  word_count: number, chapter_count: number, created_at: string,
});

const milestoneChapterFields = {
  milestone_id: string, chapter_id: string, position: number, title: string,
  act_title: nullable(string), version: number, word_count: number,
};
export const milestoneChapter: Check<MilestoneChapter> = object(milestoneChapterFields);
export const milestoneChapterWithContent = object({ ...milestoneChapterFields, content: string });

export const projectArchived = object({ id: string, archived_at: nullable(string) });

export const dialect: Check<Dialect> = literal(...DIALECTS.map((d) => d.id));

const chapterFields = {
  id: string,
  project_id: string,
  title: string,
  synopsis: string,
  revision_status: literal("drafting", "revising", "done"),
  position: number,
  word_count: number,
  version: number,
  updated_at: string,
  act_id: nullable(string),
};

export const chapterMeta: Check<ChapterMeta> = object(chapterFields);

export const act: Check<Act> = object({ id: string, project_id: string, title: string, position: number });

export const projectDetail: Check<ProjectDetail> = object({
  project: object({
    id: string,
    title: string,
    created_at: string,
    updated_at: string,
    target_words: nullable(number),
    target_date: nullable(string),
    dialect,
  }),
  chapters: array(chapterMeta),
  acts: array(act),
});

export const outline: Check<Outline> = object({ acts: array(act), chapters: array(chapterMeta) });

export const chapterWithContent: Check<ChapterWithContent> = object({ ...chapterFields, content: string });

export const bibleEntry: Check<BibleEntry> = object({
  id: string,
  project_id: string,
  kind: literal(...BIBLE_KINDS),
  name: string,
  aliases: array(string),
  body: string,
  created_at: string,
  updated_at: string,
});

export const bibleEntryDraft: Check<BibleEntryDraft> = object({
  name: string,
  kind: literal(...BIBLE_KINDS),
  aliases: array(string),
  body: string,
  source_quote: string,
  rationale: string,
  model: string,
  cost_usd: number,
});

export const checkResult: Check<CheckResult> = object({
  summary: string,
  findings: array(
    object({
      kind: literal("contradiction", "internal", "new_fact"),
      quote: string,
      entry: string,
      explanation: string,
      suggestion: string,
    }),
  ),
  entries_checked: array(string),
  model: string,
  cost_usd: number,
  checked_at: string,
});

export const bookCheckResult: Check<BookCheckResult> = object({
  summary: string,
  findings: array(
    object({
      kind: literal("contradiction", "timeline", "bible"),
      chapter_id: string,
      chapter_title: string,
      quote: string,
      conflicts_with: string,
      explanation: string,
      suggestion: string,
    }),
  ),
  chapters_checked: number,
  words_checked: number,
  entries_checked: number,
  model: string,
  cost_usd: number,
  checked_at: string,
});

export const bookCheckEvent: Check<BookCheckEvent> = tagged("type", {
  started: object({ type: literal("started"), reserved_usd: number, chapters: number, words: number }),
  progress: object({ type: literal("progress"), seconds: number }),
  result: object({ type: literal("result"), result: bookCheckResult }),
  error: object({ type: literal("error"), status: number, code: string, error: string }),
});

export const aiStatus: Check<AiStatus> = object({
  configured: boolean,
  model: string,
  daily_limit: number,
  used_last_24h: number,
  monthly_budget_usd: number,
  spent_this_month_usd: number,
  recent: array(
    object({
      id: string,
      purpose: string,
      model: string,
      status: literal("pending", "done", "failed", "unknown"),
      input_tokens: number,
      output_tokens: number,
      cost_usd: number,
      error: nullable(string),
      created_at: string,
    }),
  ),
});

export const aiTest = object({ ok: boolean, reply: string, model: string, ms: number, cost_usd: number });

export const stats: Check<Stats> = object({
  daily_goal: nullable(number),
  today: number,
  revised_today: number,
  streak_counts_revision: boolean,
  streak: number,
  best_streak: number,
  days: array(object({ day: string, words: number })),
});

export const goal = object({ daily_goal: nullable(number) });
export const streakRevision = object({ streak_counts_revision: boolean });

export const target = object({ target_words: nullable(number), target_date: nullable(string) });

export const dialectSetting = object({ dialect });

export const deletedProject: Check<DeletedProject> = object({
  id: string,
  title: string,
  deleted_at: string,
  chapter_count: number,
  word_count: number,
});

export const deletedChapter: Check<DeletedChapter> = object({
  id: string,
  title: string,
  word_count: number,
  deleted_at: string,
});

export const saveResult: Check<SaveResult> = object({
  version: number,
  word_count: number,
  updated_at: string,
  today_words: optional(number),
});

export const sceneMeta: Check<SceneMeta> = object({
  id: string,
  project_id: string,
  chapter_id: nullable(string),
  title: string,
  summary: string,
  pov: string,
  location: string,
  status: literal("planned", "drafted", "revising", "done"),
  position: number,
  in_text: boolean,
  word_count: number,
  excerpt: string,
  passage_index: nullable(number),
  unconfirmed: boolean,
  unlinked_at: nullable(string),
  merged_into: nullable(string),
  created_at: string,
  updated_at: string,
});

export const sceneListing: Check<SceneListing> = object({
  scenes: array(sceneMeta),
  placeholders: array(object({ chapter_id: string, passage_index: number, words: number, excerpt: string })),
});

const passageIndex: Check<number> = (value, path) => {
  const index = number(value, path);
  if (!Number.isInteger(index) || index < 0) throw new ShapeError(path, "a non-negative integer", value);
  return index;
};

export const sceneMoveResult = object({
  from: object({ version: number, word_count: number }),
  to: object({ version: number, word_count: number }),
  scene: sceneMeta,
  from_passage_index: passageIndex,
});

const snapshotFields = {
  id: string,
  version: number,
  word_count: number,
  reason: literal("auto", "restore", "conflict", "replace", "claude", "move"),
  created_at: string,
};

export const snapshot: Check<Snapshot> = object(snapshotFields);

export const snapshotWithContent: Check<SnapshotWithContent> = object({ ...snapshotFields, content: string });

const shareLinkFields = {
  id: string, label: string, milestone_id: nullable(string), milestone_name: nullable(string),
  track_progress: number, created_at: string, feedback_count: number,
};
export const shareLink: Check<ShareLink> = object(shareLinkFields);
export const shareCreated = object({ ...shareLinkFields, token: string });

export const claudeChange: Check<ClaudeChange> = object({
  id: string,
  created_at: string,
  action: string,
  target_kind: literal("chapter", "entry", "scene"),
  target_id: string,
  chapter_id: nullable(string),
  summary: string,
  detail: string,
});

export const claudeDraft: Check<ClaudeDraft> = object({
  chapter_id: string,
  version: number,
  base_version: number,
  word_count: number,
  ops: array(tagged("kind", {
    replace: object({ kind: literal("replace"), old_text: string, new_text: string }),
    append: object({ kind: literal("append"), text: string }),
    set: object({ kind: literal("set"), text: string }),
  })),
  created_at: string,
  updated_at: string,
  content: string,
});

export const shareComment: Check<ShareComment> = object({
  id: string,
  chapter_id: string,
  chapter_title: string,
  share_id: string,
  share_label: string,
  display_name: string,
  body: string,
  created_at: string,
});

export const sharedProject: Check<SharedProject> = object({
  project: object({ title: string }),
  label: string,
  chapters: array(object({ id: string, title: string, word_count: number })),
});

export const sharedChapter = object({ id: string, title: string, content: string });
