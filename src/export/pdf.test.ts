import { describe, expect, it } from "vitest";
import { buildPdf } from "./pdf";

describe("buildPdf", () => {
  it("creates a downloadable PDF with a title page and chapter", async () => {
    const blob = await buildPdf({
      id: "novel-id",
      title: "The Lantern",
      author: "A. Writer",
      words: 4,
      chapters: [{ title: "First Chapter", blocks: [{ kind: "para", runs: [{ text: "A beginning." }] }] }],
    });

    expect(blob.type).toBe("application/pdf");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 8))).toContain("%PDF-");
  });
});
