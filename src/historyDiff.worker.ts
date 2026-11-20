import { compareHistory } from "./historyDiff";

self.addEventListener("message", ({ data }: MessageEvent<{ snapshot: string; draft: string }>) => {
  self.postMessage(compareHistory(data.snapshot, data.draft));
});
