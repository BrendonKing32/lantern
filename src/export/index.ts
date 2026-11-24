// Builds an export file in the browser from what's on this device and the
// server: unsaved drafts win over the last saved text, so the file matches
// what's on screen. Loaded on demand, so the libraries stay out of the main
// bundle.

import { strToU8, zipSync, type Zippable } from "fflate";
import { drafts } from "../local";
import { loadChapter } from "../sync";
import { api } from "../api";
import { countWords } from "../../shared/wordcount";
import type { Milestone, ProjectDetail } from "../../shared/types";
import { buildDocx } from "./docx";
import { buildEpub } from "./epub";
import { parseChapter, partTitles, slug, type Book } from "./model";

export type ExportFormat = "docx" | "epub" | "pdf" | "md";

export const FORMATS: Record<ExportFormat, { label: string; ext: string; type: string }> = {
  docx: { label: "Word", ext: "docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  epub: { label: "EPUB", ext: "epub", type: "application/epub+zip" },
  pdf: { label: "PDF", ext: "pdf", type: "application/pdf" },
  md: { label: "Markdown", ext: "zip", type: "application/zip" },
};

export interface ChapterText {
  title: string;
  /** The act title, on the first chapter of each act. */
  part?: string;
  content: string;
}

export async function chapterTexts(detail: ProjectDetail): Promise<ChapterText[]> {
  const out: ChapterText[] = [];
  // Novels saved on this device before acts existed have none.
  const parts = partTitles(detail.chapters, detail.acts ?? []);
  for (const [i, c] of detail.chapters.entries()) {
    const part = parts[i];
    const draft = await drafts.read(c.id);
    if (draft) {
      out.push({ title: c.title, part, content: draft.content });
      continue;
    }
    try {
      out.push({ title: c.title, part, content: (await loadChapter(c.id)).data.content });
    } catch {
      throw new Error(`“${c.title}” isn't on this device yet. Connect to the internet and try again.`);
    }
  }
  return out;
}

export async function milestoneTexts(milestone: Milestone): Promise<ChapterText[]> {
  const rows = await api.milestoneChapters(milestone.id);
  const out: ChapterText[] = [];
  for (const [i, row] of rows.entries()) {
    const chapter = await api.milestoneChapter(milestone.id, row.chapter_id);
    out.push({
      title: row.title,
      part: row.act_title && (i === 0 || rows[i - 1].act_title !== row.act_title) ? row.act_title : undefined,
      content: chapter.content,
    });
  }
  return out;
}

export function markdownZip(title: string, texts: ChapterText[]): Uint8Array {
  const dir = slug(title);
  const width = String(texts.length).length < 2 ? 2 : String(texts.length).length;
  const files: Zippable = {};
  const whole: string[] = [`# ${title}`];
  // With acts, each act is a folder and a "##" heading, and chapters drop to "###".
  const hasParts = texts.some((t) => t.part);
  const partCount = texts.filter((t) => t.part).length;
  const partWidth = String(partCount).length < 2 ? 2 : String(partCount).length;
  let folder = "";
  let parts = 0;
  texts.forEach((t, i) => {
    if (t.part) {
      parts += 1;
      folder = `${String(parts).padStart(partWidth, "0")} ${slug(t.part)}/`;
      whole.push(`## ${t.part}`);
    }
    const n = String(i + 1).padStart(width, "0");
    files[`${dir}/chapters/${folder}${n} ${slug(t.title)}.md`] = strToU8(t.content.endsWith("\n") ? t.content : `${t.content}\n`);
    whole.push(`${hasParts ? "###" : "##"} ${t.title}`, t.content.trim());
  });
  files[`${dir}/${dir}.md`] = strToU8(`${whole.join("\n\n")}\n`);
  return zipSync(files);
}

export async function exportBook(detail: ProjectDetail, format: ExportFormat, author: string, texts: ChapterText[], milestoneName?: string) {
  const title = detail.project.title;
  const { ext, type } = FORMATS[format];
  let blob: Blob;
  if (format === "md") {
    blob = new Blob([markdownZip(title, texts) as BlobPart], { type });
  } else {
    const book: Book = {
      id: detail.project.id,
      title,
      author: author.trim(),
      words: texts.reduce((n, t) => n + countWords(t.content), 0),
      chapters: texts.map((t) => ({ ...parseChapter(t.title, t.content), part: t.part })),
    };
    if (format === "pdf") {
      const { buildPdf } = await import("./pdf");
      blob = await buildPdf(book);
    } else {
      const bytes = format === "docx" ? buildDocx(book) : buildEpub(book);
      blob = new Blob([bytes as BlobPart], { type });
    }
  }
  download(blob, `${slug(title)}${milestoneName ? ` – ${slug(milestoneName)}` : ""}.${ext}`);
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
