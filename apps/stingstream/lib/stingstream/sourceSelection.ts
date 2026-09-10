/**
 * Auto, or a server you chose — and what that resolves to right now.
 *
 * `sourceChooser.ts` answers "what can this be played from, best first". This answers the question
 * on top of it: *which* of those the play button will actually use, given that the person may have
 * pinned one. Layered rather than folded in, so the join and its twenty-five tests stay a pure
 * function of two API shapes and the pin does not leak into them.
 *
 * The four modes exist because "your pin cannot be honoured" is not one situation but three, and
 * they read differently to somebody looking at the screen:
 *
 *  * `auto` — no pin. The best copy, re-decided every time.
 *  * `pinned` — the pinned holder is there and can serve.
 *  * `pinned-offline` — it is listed but switched off. Auto plays; the row says why.
 *  * `pinned-missing` — it no longer holds this title at all.
 *
 * In both failure modes the film still plays, and **the pin is not deleted**. A machine that was
 * asleep comes back, and silently forgetting a deliberate choice because of that is the failure
 * people report as "it keeps resetting".
 */

import type { SourcePin } from "@/utils/sourcePinMemory";
import type { SourceChoice, SourceChoiceLabels } from "./sourceChooser";
import { formatSourceChoice } from "./sourceChooser";

/** The row key for Auto, shared by the phone sheet and the TV modal so the two cannot drift. */
export const AUTO_KEY = "auto";

export type SelectionMode =
  | "auto"
  | "pinned"
  | "pinned-offline"
  | "pinned-missing";

export interface ResolvedSelection {
  mode: SelectionMode;
  /** What the play button will use. Never a row that cannot serve. */
  selected: SourceChoice | null;
  /** What Auto resolves to right now — the recommended row. */
  autoChoice: SourceChoice | null;
  /** The pinned row, when it is in the list at all, even when it is offline. */
  pinnedChoice: SourceChoice | null;
  /**
   * What to call the pinned server in a sentence, whether or not it is still in the list.
   *
   * Null only when there is no pin. This is the whole reason the pin stores a name: the one moment
   * it is needed is the one moment the holder is missing.
   */
  pinnedName: string | null;
}

/** Which row a pin refers to, or undefined when the list no longer has it. */
const findPinned = (
  choices: readonly SourceChoice[],
  pin: SourcePin,
): SourceChoice | undefined => {
  if (pin.node === null) {
    // The copy on this server. A folder can hold two cuts of one film, and both rows are `local`
    // with no node id to tell them apart, so the hash is the tiebreak when there was one.
    const locals = choices.filter((c) => c.local);
    if (locals.length === 0) return undefined;
    if (pin.fileHash) {
      const exact = locals.find(
        (c) => c.fileHash?.toLowerCase() === pin.fileHash?.toLowerCase(),
      );
      if (exact) return exact;
    }

    return locals[0];
  }

  const node = pin.node.toLowerCase();
  return choices.find((c) => c.node?.toLowerCase() === node);
};

/** What the play button will use, and why. */
export function resolveSourceSelection(
  choices: readonly SourceChoice[],
  pin: SourcePin | undefined,
): ResolvedSelection {
  const autoChoice = choices.find((c) => c.recommended && !c.disabled) ?? null;

  if (!pin) {
    return {
      mode: "auto",
      selected: autoChoice,
      autoChoice,
      pinnedChoice: null,
      pinnedName: null,
    };
  }

  const pinnedChoice = findPinned(choices, pin) ?? null;
  const pinnedName = pinnedChoice?.nodeName ?? pin.nodeName ?? null;

  if (!pinnedChoice) {
    return {
      mode: "pinned-missing",
      selected: autoChoice,
      autoChoice,
      pinnedChoice: null,
      pinnedName,
    };
  }

  if (pinnedChoice.disabled) {
    return {
      mode: "pinned-offline",
      selected: autoChoice,
      autoChoice,
      pinnedChoice,
      pinnedName,
    };
  }

  return {
    mode: "pinned",
    selected: pinnedChoice,
    autoChoice,
    pinnedChoice,
    pinnedName,
  };
}

export interface SourceMenuRow {
  /** `AUTO_KEY`, or the row's `mediaSourceId`. */
  key: string;
  /** Null on the Auto row. */
  choice: SourceChoice | null;
  selected: boolean;
}

/**
 * The menu, Auto first.
 *
 * Auto leads because it is the default and because it is the answer to a different question from
 * the rows under it — "decide for me" rather than "use this one" — and a list that buries it under
 * three machine names reads as though a machine has to be picked.
 */
export function buildSourceMenu(
  choices: readonly SourceChoice[],
  resolved: ResolvedSelection,
): SourceMenuRow[] {
  const rows: SourceMenuRow[] = [
    { key: AUTO_KEY, choice: null, selected: resolved.mode === "auto" },
  ];

  for (const choice of choices) {
    rows.push({
      key: choice.mediaSourceId,
      choice,
      selected:
        resolved.mode !== "auto" &&
        resolved.pinnedChoice?.mediaSourceId === choice.mediaSourceId,
    });
  }

  return rows;
}

/**
 * What Auto resolves to, as one line: `Attic PC · 2160p · 45 Mb/s · 18 ms · Direct`.
 *
 * Null when nothing can be played, which is a different sentence and belongs to the caller.
 */
export function formatAutoTarget(
  autoChoice: SourceChoice | null,
  labels: SourceChoiceLabels,
): string | null {
  if (!autoChoice) return null;
  const { title, subtitle } = formatSourceChoice(autoChoice, labels);
  return subtitle ? `${title} · ${subtitle}` : title;
}

/**
 * What the collapsed control on the details page reads: "Auto", or the server's name.
 *
 * A pin whose holder is offline or gone still reads as that holder's name, not as "Auto" — the
 * control has to keep saying what was chosen, and the line underneath it says why it is not being
 * used right now. Flipping the label back to Auto would look like the choice had been discarded.
 */
export function selectionLabel(
  resolved: ResolvedSelection,
  autoLabel: string,
): string {
  return resolved.mode === "auto"
    ? autoLabel
    : (resolved.pinnedName ?? autoLabel);
}
