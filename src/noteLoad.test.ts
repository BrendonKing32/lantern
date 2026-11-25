import { describe, expect, it } from "vitest";
import { NoteLoadGate } from "./noteLoad";

describe("note list requests", () => {
  it("ignores an earlier list after a mutation or a newer load", () => {
    const gate = new NoteLoadGate();
    const beforeMutation = gate.start();
    gate.invalidate();
    expect(beforeMutation()).toBe(false);
    const first = gate.start();
    const second = gate.start();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});
