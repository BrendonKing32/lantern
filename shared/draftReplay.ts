import type { DraftOp } from "./types";

export interface ReplayResult {
  text: string;
  applied: number;
  failed: { index: number; op: DraftOp; reason: "missing" | "ambiguous" }[];
}

const normalize = (text: string) => text.replace(/\r\n?/g, "\n");

function originalOffset(text: string, offset: number): number {
  let normalized = 0;
  for (let i = 0; i < text.length; i++) {
    if (normalized === offset) return i;
    if (text[i] === "\r" && text[i + 1] === "\n") i++;
    normalized++;
  }
  return text.length;
}

export function replayDraft(current: string, ops: DraftOp[]): ReplayResult {
  let text = current;
  let applied = 0;
  const failed: ReplayResult["failed"] = [];
  const newline = current.includes("\r\n") ? "\r\n" : current.includes("\r") ? "\r" : "\n";
  const lineEndings = (value: string) => normalize(value).replace(/\n/g, newline);
  ops.forEach((op, index) => {
    if (op.kind === "set") {
      if (text.trim()) {
        failed.push({ index, op, reason: "missing" });
        return;
      }
      text = lineEndings(op.text);
    } else if (op.kind === "append") {
      const body = text.replace(/\s+$/, "");
      const addition = lineEndings(op.text);
      const next = body ? `${body}${newline}${newline}${addition.replace(/^\s+/, "")}` : addition;
      text = next.endsWith(newline) ? next : `${next}${newline}`;
    } else {
      const haystack = normalize(text);
      const needle = normalize(op.old_text);
      const start = needle ? haystack.indexOf(needle) : -1;
      if (start < 0 || haystack.indexOf(needle, start + 1) !== -1) {
        failed.push({ index, op, reason: start < 0 ? "missing" : "ambiguous" });
        return;
      }
      const from = originalOffset(text, start);
      const to = originalOffset(text, start + needle.length);
      text = text.slice(0, from) + lineEndings(op.new_text) + text.slice(to);
    }
    applied++;
  });
  return { text, applied, failed };
}
