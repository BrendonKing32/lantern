// Word (.docx) in standard manuscript format: Times New Roman 12pt, double
// spaced, half-inch paragraph indents, one-inch margins, each chapter on a new
// page a third of the way down (an act's title on a page of its own before
// its first chapter), "#" for scene breaks, and a running header of
// "Author / TITLE / page" from the second page on.

import { strToU8, zipSync, type Zippable } from "fflate";
import { aboutWords, type Block, type Book, type Run } from "./model";

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Characters XML 1.0 forbids would make Word refuse the whole file.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "");

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function run(r: Run): string {
  if (r.br) return "<w:r><w:br/></w:r>";
  const props = [
    r.bold ? "<w:b/>" : "",
    r.italic ? "<w:i/>" : "",
    r.strike ? "<w:strike/>" : "",
    r.code ? '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>' : "",
  ].join("");
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(r.text)}</w:t></w:r>`;
}

const para = (style: string, runs: Run[] | string) =>
  `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${
    typeof runs === "string" ? run({ text: runs }) : runs.map(run).join("")
  }</w:p>`;

function block(b: Block): string {
  if (b.kind === "break") return para("SceneBreak", "#");
  if (b.kind === "heading") return para(b.level <= 1 ? "Subheading" : "Subheading2", b.runs);
  const style = b.style === "quote" ? "BlockQuote" : b.style === "code" ? "Code" : b.style === "item" ? "ListItem" : "Normal";
  return para(style, b.runs.length ? b.runs : "");
}

function documentXml(book: Book): string {
  const body: string[] = [
    // Title page.
    para("TitleLength", aboutWords(book.words)),
    para("Title", book.title),
    book.author ? para("Byline", `by ${book.author}`) : "",
  ];
  for (const ch of book.chapters) {
    if (ch.part) body.push(para("PartTitle", ch.part));
    body.push(para("ChapterTitle", ch.title));
    body.push(...ch.blocks.map(block));
  }
  body.push(para("SceneBreak", "END"));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>${body.join("")}<w:sectPr>
<w:headerReference w:type="default" r:id="rHeader"/>
<w:pgSz w:w="12240" w:h="15840"/>
<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
<w:titlePg/>
</w:sectPr></w:body></w:document>`;
}

function headerXml(book: Book): string {
  const surname = book.author.trim().split(/\s+/).pop() ?? "";
  const label = `${surname ? `${surname} / ` : ""}${book.title.toUpperCase()} / `;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${W}><w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr>${run({ text: label })}<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>2</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:hdr>`;
}

const style = (id: string, name: string, pPr: string, rPr = "", basedOn = "Normal") =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="${basedOn}"/><w:next w:val="Normal"/><w:qFormat/><w:pPr>${pPr}</w:pPr>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}</w:style>`;

const CENTER = '<w:jc w:val="center"/><w:ind w:firstLine="0"/>';

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}>
<w:docDefaults>
<w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="480" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:firstLine="720"/><w:widowControl/></w:pPr></w:style>
${style("Title", "Title", `${CENTER}<w:spacing w:before="4320"/>`, '<w:sz w:val="32"/><w:szCs w:val="32"/>')}
${style("Byline", "Byline", CENTER)}
${style("TitleLength", "Word Count", '<w:jc w:val="right"/><w:ind w:firstLine="0"/>')}
${style("PartTitle", "Part Title", `<w:pageBreakBefore/>${CENTER}<w:spacing w:before="4320"/><w:outlineLvl w:val="0"/>`, '<w:sz w:val="32"/><w:szCs w:val="32"/>')}
${style("ChapterTitle", "Chapter Title", `<w:pageBreakBefore/><w:keepNext/>${CENTER}<w:spacing w:before="2880" w:after="480"/><w:outlineLvl w:val="0"/>`)}
${style("Subheading", "Subheading", `<w:keepNext/>${CENTER}<w:outlineLvl w:val="1"/>`, "<w:b/>")}
${style("Subheading2", "Subheading 2", `<w:keepNext/>${CENTER}<w:outlineLvl w:val="2"/>`, "<w:i/>")}
${style("SceneBreak", "Scene Break", CENTER)}
${style("BlockQuote", "Block Quote", '<w:ind w:left="720" w:right="720" w:firstLine="0"/>')}
${style("ListItem", "List Item", '<w:ind w:left="720" w:hanging="360"/>')}
${style("Code", "Code", '<w:ind w:left="720" w:firstLine="0"/><w:spacing w:line="240" w:lineRule="auto"/>', '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="20"/>')}
${style("Header", "Header", '<w:jc w:val="right"/><w:ind w:firstLine="0"/><w:spacing w:line="240" w:lineRule="auto"/>')}
</w:styles>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
</Relationships>`;

function coreXml(book: Book): string {
  const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${esc(book.title)}</dc:title><dc:creator>${esc(book.author)}</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">${at}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${at}</dcterms:modified>
</cp:coreProperties>`;
}

export function buildDocx(book: Book): Uint8Array {
  const files: Zippable = {
    "[Content_Types].xml": strToU8(CONTENT_TYPES),
    "_rels/.rels": strToU8(ROOT_RELS),
    "docProps/core.xml": strToU8(coreXml(book)),
    "word/document.xml": strToU8(documentXml(book)),
    "word/styles.xml": strToU8(STYLES),
    "word/header1.xml": strToU8(headerXml(book)),
    "word/_rels/document.xml.rels": strToU8(DOC_RELS),
  };
  return zipSync(files);
}
