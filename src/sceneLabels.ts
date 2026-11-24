import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type Command, type DecorationSet } from "@codemirror/view";
import { matchScenes, splitScenes, usualBreak, type MatchCard } from "../shared/scenes";
import type { SceneMeta } from "../shared/types";

export interface SceneLabelSnapshot {
  /** Saved chapter text corresponding to the cards' passage_index values. */
  baselineText: string;
  chapterTitle: string;
  /** Cards for this chapter, from the same listing as baselineText. */
  cards: readonly SceneMeta[];
}

export interface SceneLabelHost {
  snapshot: () => SceneLabelSnapshot;
  open: (card: SceneMeta) => void;
}

export interface SceneLabel {
  from: number;
  text: string;
  card: SceneMeta | null;
}

const ENABLED_KEY = "lantern-scene-labels";

/** Whether scene labels are on for this device. On unless turned off. */
export function sceneLabelsEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSceneLabelsEnabled(on: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, on ? "on" : "off");
  } catch {
    // The setting still applies for this session.
  }
}

/**
 * The API omits stored anchors. Reconstruct them from the saved text, never
 * the edited document; a stale or mismatched baseline cannot identify cards.
 */
export function computeSceneLabels(text: string, snapshot: SceneLabelSnapshot): SceneLabel[] {
  const baseline = splitScenes(snapshot.baselineText, snapshot.chapterTitle);
  const passages = splitScenes(text, snapshot.chapterTitle);
  const indexCounts = new Map<number, number>();
  for (const card of snapshot.cards) {
    if (card.in_text && card.passage_index !== null) {
      indexCounts.set(card.passage_index, (indexCounts.get(card.passage_index) ?? 0) + 1);
    }
  }
  const eligible = snapshot.cards.filter((card) =>
    card.in_text && card.passage_index !== null &&
    Number.isInteger(card.passage_index) && card.passage_index >= 0 &&
    card.passage_index < baseline.length && indexCounts.get(card.passage_index) === 1,
  );
  const matchCards: MatchCard[] = eligible.map((card) => {
    const passage = baseline[card.passage_index!];
    return {
      id: card.id,
      in_text: true,
      position: card.position,
      anchor_head: passage.head,
      anchor_tail: passage.tail,
    };
  });
  const matches = matchScenes(passages, matchCards);
  const byIndex = new Map([...matches.pairs].map(([id, index]) =>
    [index, eligible.find((card) => card.id === id)!] as const,
  ));
  return passages.map((passage) => {
    const card = byIndex.get(passage.index) ?? null;
    return {
      from: passage.index === 0 ? 0 : passage.start,
      text: card?.title ?? `Scene ${passage.index + 1} · no card`,
      card,
    };
  });
}

class SceneLabelWidget extends WidgetType {
  constructor(private readonly label: SceneLabel, private readonly open: SceneLabelHost["open"]) {
    super();
  }

  eq(other: SceneLabelWidget): boolean {
    return this.label.text === other.label.text && this.label.card === other.label.card;
  }

  toDOM(): HTMLElement {
    const element = document.createElement(this.label.card ? "button" : "span");
    element.className = "cm-scene-label";
    element.textContent = this.label.text;
    if (this.label.card && element instanceof HTMLButtonElement) {
      element.type = "button";
      const card = this.label.card;
      element.addEventListener("click", () => this.open(card));
    }
    return element;
  }
}

/** Dispatch after the host's saved baseline, title or card listing changes. */
export const sceneLabelsChanged = StateEffect.define<null>();

const replaceLabels = StateEffect.define<DecorationSet>();

function decorations(text: string, host: SceneLabelHost): DecorationSet {
  return Decoration.set(computeSceneLabels(text, host.snapshot()).map((label) =>
    Decoration.widget({ widget: new SceneLabelWidget(label, host.open), block: true, side: -1 }).range(label.from),
  ));
}

/** Labels only; leave sceneBreakKeymap installed when labels are toggled off. */
export function sceneLabels(host: SceneLabelHost): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => decorations(state.doc.toString(), host),
    update(value, transaction) {
      value = value.map(transaction.changes);
      for (const effect of transaction.effects) {
        if (effect.is(replaceLabels)) value = effect.value;
      }
      return value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
  const refresh = ViewPlugin.fromClass(class {
    private timer: ReturnType<typeof setTimeout> | undefined;

    update(update: import("@codemirror/view").ViewUpdate) {
      if (!update.docChanged && !update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(sceneLabelsChanged)))) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        update.view.dispatch({ effects: replaceLabels.of(decorations(update.view.state.doc.toString(), host)) });
      }, 300);
    }

    destroy() {
      clearTimeout(this.timer);
    }
  });
  return [
    field,
    refresh,
    EditorView.baseTheme({
      ".cm-scene-label": {
        display: "block",
        padding: "0.35em 0",
        border: "0",
        background: "transparent",
        color: "var(--text-faint)",
        font: "inherit",
        fontSize: "0.8em",
        textAlign: "left",
      },
      "button.cm-scene-label": { cursor: "pointer", color: "var(--text-soft)" },
    }),
  ];
}

/** Insert the chapter's most common break without changing the surrounding text. */
export const insertSceneBreak: Command = (view) => {
  if (view.state.readOnly) return false;
  const line = usualBreak(splitScenes(view.state.doc.toString()));
  view.dispatch(view.state.replaceSelection(`\n\n${line}\n\n`), { scrollIntoView: true, userEvent: "input" });
  return true;
};

export const sceneBreakKeymap = keymap.of([{ key: "Mod-Shift-Enter", run: insertSceneBreak }]);
