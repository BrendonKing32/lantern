/** Ignore an earlier list response after a newer load or local mutation. */
export class NoteLoadGate {
  private generation = 0;
  start(): () => boolean {
    const generation = ++this.generation;
    return () => this.generation === generation;
  }
  invalidate(): void {
    this.generation++;
  }
}
