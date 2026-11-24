import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildDocx } from "./docx";
import { buildEpub } from "./epub";
import { markdownZip } from "./index";
import { partTitles, type Book } from "./model";
import { buildPdf } from "./pdf";

const para = (text: string) => ({ kind: "para" as const, runs: [{ text }] });

const book: Book = {
  id: "novel-id",
  title: "The Lantern",
  author: "A. Writer",
  words: 6,
  chapters: [
    { title: "Prologue", blocks: [para("Before.")] },
    { title: "Arrival", part: "Act One", blocks: [para("She came.")] },
    { title: "Harbour", blocks: [para("The sea.")] },
    { title: "Tower", part: "Act Two", blocks: [para("Up.")] },
  ],
};

describe("act headings in exports", () => {
  it("marks the first chapter of each act, skipping empty and unknown acts", () => {
    const acts = [{ id: "a", title: "Act One" }, { id: "empty", title: "Empty" }, { id: "b", title: "Act Two" }];
    expect(
      partTitles([{ act_id: null }, { act_id: "a" }, { act_id: "a" }, { act_id: "b" }, { act_id: "gone" }], acts),
    ).toEqual([undefined, "Act One", undefined, "Act Two", undefined]);
    expect(partTitles([{ act_id: null }, {}], [])).toEqual([undefined, undefined]);
  });

  it("puts a part title before each act's first chapter in Word", () => {
    const xml = strFromU8(unzipSync(buildDocx(book))["word/document.xml"]);
    const order = [...xml.matchAll(/w:val="(PartTitle|ChapterTitle)"\/><\/w:pPr><w:r><w:t xml:space="preserve">([^<]*)/g)].map(
      (m) => `${m[1]}:${m[2]}`,
    );
    expect(order).toEqual([
      "ChapterTitle:Prologue",
      "PartTitle:Act One",
      "ChapterTitle:Arrival",
      "ChapterTitle:Harbour",
      "PartTitle:Act Two",
      "ChapterTitle:Tower",
    ]);
  });

  it("gives each act a page and nests its chapters in the EPUB contents", () => {
    const files = unzipSync(buildEpub(book));
    expect(strFromU8(files["OEBPS/part-001.xhtml"])).toContain("<h1>Act One</h1>");
    const nav = strFromU8(files["OEBPS/nav.xhtml"]).replace(/\n/g, "");
    expect(nav).toContain(
      '<ol><li><a href="chapter-001.xhtml">Prologue</a></li><li><a href="part-001.xhtml">Act One</a><ol>' +
        '<li><a href="chapter-002.xhtml">Arrival</a></li><li><a href="chapter-003.xhtml">Harbour</a></li></ol></li>' +
        '<li><a href="part-002.xhtml">Act Two</a><ol><li><a href="chapter-004.xhtml">Tower</a></li></ol></li></ol>',
    );
    const spine = [...strFromU8(files["OEBPS/content.opf"]).matchAll(/<itemref idref="([^"]+)"/g)].map((m) => m[1]);
    expect(spine).toEqual(["title", "nav", "ch001", "part001", "ch002", "ch003", "part002", "ch004"]);
  });

  it("builds a PDF with act pages", async () => {
    const blob = await buildPdf(book);
    expect(blob.type).toBe("application/pdf");
  });

  it("files Markdown chapters by act and adds act headings", () => {
    const files = unzipSync(
      markdownZip("The Lantern", [
        { title: "Prologue", content: "Before." },
        { title: "Arrival", part: "Act One", content: "She came." },
        { title: "Tower", part: "Act Two", content: "Up." },
      ]),
    );
    expect(Object.keys(files).sort()).toEqual([
      "The Lantern/The Lantern.md",
      "The Lantern/chapters/01 Act One/02 Arrival.md",
      "The Lantern/chapters/01 Prologue.md",
      "The Lantern/chapters/02 Act Two/03 Tower.md",
    ]);
    expect(strFromU8(files["The Lantern/The Lantern.md"])).toBe(
      "# The Lantern\n\n### Prologue\n\nBefore.\n\n## Act One\n\n### Arrival\n\nShe came.\n\n## Act Two\n\n### Tower\n\nUp.\n",
    );
  });

  it("leaves Markdown as before for a book without acts", () => {
    const files = unzipSync(markdownZip("Book", [{ title: "One", content: "Text." }]));
    expect(strFromU8(files["Book/Book.md"])).toBe("# Book\n\n## One\n\nText.\n");
  });
});
