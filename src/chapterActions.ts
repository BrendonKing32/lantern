export const CHAPTER_ACTIONS_OPEN_EVENT = "chapter-actions-open";

export function closeOtherChapterActions(
  opened: HTMLDetailsElement,
  current: HTMLDetailsElement | null,
): void {
  if (current && current !== opened) current.open = false;
}

export function shouldCloseChapterActions(
  actions: HTMLDetailsElement | null,
  target: Node,
): boolean {
  return Boolean(actions?.open && !actions.contains(target));
}
