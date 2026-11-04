// Builds an export file in the browser from what's on this device and the
// server: unsaved drafts win over the last saved text, so the file matches
// what's on screen. Loaded on demand, so the libraries stay out of the main
// bundle.

import { strToU8, zipSync, type Zippable } from "fflate";
import { drafts } from "../local";
import { loadChapter } from "../sync";
import { countWords } from "../../shared/wordcount";
import type { ProjectDetail } from "../../shared/types";
import { buildDocx } from "./docx";
import { buildEpub } from "./epub";
import { parseChapter, slug, type Book } from "./model";

export type ExportFormat = "docx" | "epub" | "md";

export const FORMATS: Record<ExportFormat, { label: string; ext: string; type: string }> = {
  docx: { label: "Word", ext: "docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  epub: { label: "EPUB", ext: "epub", type: "application/epub+zip" },
  md: { label: "Markdown", ext: "zip", type: "application/zip" },
};

async function chapterTexts(detail: ProjectDetail) {
  const out: { title: string; content: string }[] = [];
  for (const c of detail.chapters) {
    const draft = await drafts.read(c.id);
    if (draft) {
      out.push({ title: c.title, content: draft.content });
      continue;
    }
    try {
      out.push({ title: c.title, content: (await loadChapter(c.id)).data.content });
    } catch {
      throw new Error(`“${c.title}” isn't on this device yet. Connect to the internet and try again.`);
    }
  }
  return out;
}

function markdownZip(title: string, texts: { title: string; content: string }[]): Uint8Array {
  const dir = slug(title);
  const width = String(texts.length).length < 2 ? 2 : String(texts.length).length;
  const files: Zippable = {};
  const whole: string[] = [`# ${title}`];
  texts.forEach((t, i) => {
    const n = String(i + 1).padStart(width, "0");
    files[`${dir}/chapters/${n} ${slug(t.title)}.md`] = strToU8(t.content.endsWith("\n") ? t.content : `${t.content}\n`);
    whole.push(`## ${t.title}`, t.content.trim());
  });
  files[`${dir}/${dir}.md`] = strToU8(`${whole.join("\n\n")}\n`);
  return zipSync(files);
}

export async function exportBook(detail: ProjectDetail, format: ExportFormat, author: string) {
  const texts = await chapterTexts(detail);
  const title = detail.project.title;
  let bytes: Uint8Array;
  if (format === "md") {
    bytes = markdownZip(title, texts);
  } else {
    const book: Book = {
      id: detail.project.id,
      title,
      author: author.trim(),
      words: texts.reduce((n, t) => n + countWords(t.content), 0),
      chapters: texts.map((t) => parseChapter(t.title, t.content)),
    };
    bytes = format === "docx" ? buildDocx(book) : buildEpub(book);
  }
  const { ext, type } = FORMATS[format];
  download(new Blob([bytes as BlobPart], { type }), `${slug(title)}.${ext}`);
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
