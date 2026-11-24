import { compareHistory, countChangedWords } from "./historyDiff";

self.addEventListener("message", ({ data }: MessageEvent<{ snapshot: string; draft: string; countWords?: boolean }>) => {
  self.postMessage(data.countWords ? countChangedWords(data.snapshot, data.draft) : compareHistory(data.snapshot, data.draft));
});
