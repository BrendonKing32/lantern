import * as pdfMake from "pdfmake/build/pdfmake";
import vfs from "pdfmake/build/vfs_fonts";
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import type { Block, Book, Run } from "./model";

pdfMake.addVirtualFileSystem(vfs);

function run(r: Run): Content {
  return {
    text: r.br ? "\n" : r.text,
    ...(r.bold ? { bold: true } : {}),
    ...(r.italic ? { italics: true } : {}),
    ...(r.strike ? { decoration: "lineThrough" as const } : {}),
  };
}

const runs = (items: Run[]): Content[] => items.map(run);

function paragraph(block: Block): Content {
  if (block.kind === "break") {
    return { text: "*", style: "sceneBreak" };
  }
  if (block.kind === "heading") {
    return {
      text: runs(block.runs),
      style: block.level <= 1 ? "subheading" : "subheading2",
      outline: true,
    };
  }
  return {
    text: runs(block.runs),
    style: block.style === "quote" ? "quote" : block.style === "code" ? "code" : block.style === "item" ? "item" : "body",
  };
}

function definition(book: Book): TDocumentDefinitions {
  const content: Content[] = [
    {
      stack: [
        { text: book.title, style: "title" },
        ...(book.author ? [{ text: book.author, style: "byline" }] : []),
      ],
      alignment: "center",
      margin: [0, 170, 0, 0],
      ...(book.chapters.length ? { pageBreak: "after" as const } : {}),
    },
  ];

  book.chapters.forEach((chapter, i) => {
    // An act's title gets a page of its own before its first chapter.
    if (chapter.part) {
      content.push({
        text: chapter.part,
        style: "part",
        ...(i ? { pageBreak: "before" as const } : {}),
        outline: true,
      });
    }
    content.push({
      text: chapter.title,
      style: "chapter",
      ...(i || chapter.part ? { pageBreak: "before" as const } : {}),
      outline: true,
    });
    content.push(...chapter.blocks.map(paragraph));
  });

  return {
    pageSize: "LETTER",
    pageMargins: [72, 54, 72, 60],
    info: { title: book.title, author: book.author, creator: "Lantern" },
    defaultStyle: { font: "Roboto", fontSize: 11, lineHeight: 1.4 },
    styles: {
      title: { fontSize: 26, bold: true, lineHeight: 1.2 },
      byline: { fontSize: 13, margin: [0, 18, 0, 0] },
      part: { fontSize: 22, alignment: "center", margin: [0, 200, 0, 0] },
      chapter: { fontSize: 18, alignment: "center", margin: [0, 132, 0, 28] },
      subheading: { fontSize: 14, bold: true, alignment: "center", margin: [0, 24, 0, 14] },
      subheading2: { fontSize: 12, italics: true, alignment: "center", margin: [0, 20, 0, 12] },
      body: { alignment: "justify", margin: [0, 0, 0, 12] },
      quote: { italics: true, margin: [24, 0, 24, 12] },
      item: { margin: [18, 0, 0, 8] },
      code: { fontSize: 10, margin: [18, 0, 0, 8] },
      sceneBreak: { alignment: "center", margin: [0, 16, 0, 16] },
    },
    footer: (currentPage) =>
      currentPage === 1 ? "" : { text: String(currentPage - 1), alignment: "center", fontSize: 9, margin: [0, 0, 0, 24] },
    content,
  };
}

export async function buildPdf(book: Book): Promise<Blob> {
  return pdfMake.createPdf(definition(book)).getBlob();
}
