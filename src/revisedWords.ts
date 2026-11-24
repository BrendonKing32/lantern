import type { ChangeSet, Text } from "@codemirror/state";
import { countWords } from "../shared/wordcount";

/** Count both sides of each change against the document before the transaction. */
export function revisedWords(changes: ChangeSet, before: Text): number {
  let words = 0;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    words += countWords(before.sliceString(fromA, toA)) + countWords(inserted.toString());
  });
  return words;
}
