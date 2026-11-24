// EPUB 3 e-book: a title page, one XHTML file per chapter (and a page for
// each act's title before its first chapter), a table of contents, and a light stylesheet that leaves fonts to the reader's device.

import { strToU8, zipSync, type Zippable } from "fflate";
import type { Block, Book, Run } from "./model";

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "");

function run(r: Run): string {
  if (r.br) return "<br/>";
  let s = esc(r.text);
  if (r.code) s = `<code>${s}</code>`;
  if (r.strike) s = `<del>${s}</del>`;
  if (r.bold) s = `<strong>${s}</strong>`;
  if (r.italic) s = `<em>${s}</em>`;
  return s;
}
const runs = (rs: Run[]) => rs.map(run).join("");

function blocksHtml(blocks: Block[]): string {
  const out: string[] = [];
  let prevBreakOrStart = true;
  for (const b of blocks) {
    if (b.kind === "break") {
      out.push('<p class="break" role="separator">*</p>');
      prevBreakOrStart = true;
    } else if (b.kind === "heading") {
      const level = Math.min(6, b.level + 1); // the chapter title is the h1
      out.push(`<h${level}>${runs(b.runs)}</h${level}>`);
      prevBreakOrStart = true;
    } else {
      // Book typography: no indent on the first paragraph of a chapter or scene.
      const cls = [b.style ?? "", b.style ? "" : prevBreakOrStart ? "first" : ""].filter(Boolean).join(" ");
      out.push(`<p${cls ? ` class="${cls}"` : ""}>${runs(b.runs) || "&#160;"}</p>`);
      prevBreakOrStart = false;
    }
  }
  return out.join("\n");
}

const page = (lang: string, title: string, body: string, extra = "") => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head><meta charset="utf-8"/><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/>${extra}</head>
<body>
${body}
</body>
</html>`;

const CSS = `body { margin: 0 5%; line-height: 1.5; }
h1 { margin: 3em 0 2em; text-align: center; font-weight: normal; font-size: 1.5em; }
h2, h3, h4, h5, h6 { text-align: center; font-size: 1.1em; margin: 1.5em 0 1em; }
p { margin: 0; text-indent: 1.5em; }
p.first, p.break, p.quote, p.item, p.code { text-indent: 0; }
p.break { text-align: center; margin: 1em 0; }
p.quote { margin: 0 2em; font-style: italic; }
p.item { margin-left: 1.5em; }
p.code { font-family: monospace; font-size: 0.9em; white-space: pre-wrap; margin-left: 1.5em; }
.titlepage { text-align: center; margin-top: 30%; }
.part h1 { margin-top: 30%; font-size: 1.8em; }
.titlepage h1 { margin: 0 0 1em; font-size: 2em; }
nav ol { list-style: none; padding: 0; }
nav li { margin: 0.4em 0; }
nav ol ol { padding-left: 1.5em; }
`;

export function buildEpub(book: Book): Uint8Array {
  const lang = (typeof navigator !== "undefined" && navigator.language) || "en";
  const files: Zippable = {
    // The mimetype must come first and be stored uncompressed.
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
    "OEBPS/style.css": strToU8(CSS),
    "OEBPS/title.xhtml": strToU8(
      page(
        lang,
        book.title,
        `<section class="titlepage" epub:type="titlepage"><h1>${esc(book.title)}</h1>${
          book.author ? `<p class="first">${esc(book.author)}</p>` : ""
        }</section>`,
      ),
    ),
  };

  const items = book.chapters.map((ch, i) => ({
    id: `ch${String(i + 1).padStart(3, "0")}`,
    href: `chapter-${String(i + 1).padStart(3, "0")}.xhtml`,
    ch,
  }));
  // Reading order, with each act's title page before its first chapter.
  const spine: { id: string; href: string }[] = [];
  let parts = 0;
  const toc: string[] = [];
  let inPart = false;
  for (const { id, href, ch } of items) {
    if (ch.part) {
      parts += 1;
      const partId = `part${String(parts).padStart(3, "0")}`;
      const partHref = `part-${String(parts).padStart(3, "0")}.xhtml`;
      files[`OEBPS/${partHref}`] = strToU8(
        page(lang, ch.part, `<section class="part" epub:type="part">\n<h1>${esc(ch.part)}</h1>\n</section>`),
      );
      spine.push({ id: partId, href: partHref });
      if (inPart) toc.push("</ol></li>");
      toc.push(`<li><a href="${partHref}">${esc(ch.part)}</a><ol>`);
      inPart = true;
    }
    files[`OEBPS/${href}`] = strToU8(
      page(lang, ch.title, `<section epub:type="chapter">\n<h1>${esc(ch.title)}</h1>\n${blocksHtml(ch.blocks)}\n</section>`),
    );
    spine.push({ id, href });
    toc.push(`<li><a href="${href}">${esc(ch.title)}</a></li>`);
  }
  if (inPart) toc.push("</ol></li>");

  files["OEBPS/nav.xhtml"] = strToU8(
    page(lang, "Contents", `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>\n${toc.join("\n")}\n</ol></nav>`),
  );

  const modified = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  files["OEBPS/content.opf"] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">urn:uuid:${esc(book.id)}</dc:identifier>
<dc:title>${esc(book.title)}</dc:title>
${book.author ? `<dc:creator>${esc(book.author)}</dc:creator>` : ""}
<dc:language>${esc(lang)}</dc:language>
<meta property="dcterms:modified">${modified}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="css" href="style.css" media-type="text/css"/>
<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>
${spine.map(({ id, href }) => `<item id="${id}" href="${href}" media-type="application/xhtml+xml"/>`).join("\n")}
</manifest>
<spine>
<itemref idref="title"/>
<itemref idref="nav"/>
${spine.map(({ id }) => `<itemref idref="${id}"/>`).join("\n")}
</spine>
</package>`);

  return zipSync(files);
}
