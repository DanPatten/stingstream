/**
 * Which copy the play button will use: Auto, or the server somebody chose.
 *
 * Replaces `usePreferredSourcePreselect`, which could only ever nudge the selection when this
 * device's policy disagreed with the node's — it returns early when they agree, which is exactly
 * the common case, and a pin has to outrank the ordering either way.
 *
 * The pin lives in device storage (`utils/sourcePinMemory`) and MMKV is not reactive, so it is
 * mirrored into state here: a write has to re-render the control that shows it.
 */

import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SourceChoiceLabels } from "@/lib/stingstream/sourceChooser";
import {
  AUTO_KEY,
  buildSourceMenu,
  formatAutoTarget,
  type ResolvedSelection,
  resolveSourceSelection,
  type SourceMenuRow,
  selectionLabel,
} from "@/lib/stingstream/sourceSelection";
import {
  clearSourcePin,
  getSourcePin,
  rememberSourcePin,
  type SourcePin,
  sourcePinKey,
} from "@/utils/sourcePinMemory";
import {
  type UseItemSourcesOptions,
  type UseSourceChoicesResult,
  useSourceChoices,
} from "./useItemSources";

export interface UseSourceSelectionOptions extends UseItemSourcesOptions {
  currentMediaSourceId?: string | null;
  /** Called with the `MediaSourceInfo.Id` to play. Never called with the current one. */
  onSelectMediaSource?: (mediaSourceId: string) => void;
}

export interface UseSourceSelectionResult extends UseSourceChoicesResult {
  resolved: ResolvedSelection;
  menu: SourceMenuRow[];
  /** "Auto", or the name of the server that was chosen. */
  label: string;
  /** What Auto resolves to right now, as one line, or null when nothing can play. */
  autoTarget: string | null;
  /** The translated words the pure formatters need. */
  labels: SourceChoiceLabels;
  /** `AUTO_KEY` clears the pin; anything else pins that row. */
  choose: (key: string) => void;
}

export const useSourceSelection = (
  item: BaseItemDto | null | undefined,
  options: UseSourceSelectionOptions = {},
): UseSourceSelectionResult => {
  const { t } = useTranslation();
  const { currentMediaSourceId, onSelectMediaSource, ...queryOptions } =
    options;
  const result = useSourceChoices(item, {
    ...queryOptions,
    currentMediaSourceId,
  });

  const pinKey = useMemo(() => sourcePinKey(item), [item]);
  const [pin, setPin] = useState<SourcePin | undefined>(() =>
    getSourcePin(pinKey),
  );

  // Re-read when the screen moves to a different title. Storage is not reactive, so nothing else
  // would tell this hook that the answer changed.
  useEffect(() => {
    setPin(getSourcePin(pinKey));
  }, [pinKey]);

  const labels: SourceChoiceLabels = useMemo(
    () => ({
      direct: t("player.source.direct"),
      relayed: t("player.source.relayed"),
      connecting: t("player.source.connecting"),
      offline: t("player.source.offline"),
      recommended: t("player.source.recommended"),
      sameFile: t("player.source.same_file"),
      playing: t("player.source.playing"),
    }),
    [t],
  );

  const resolved = useMemo(
    () => resolveSourceSelection(result.choices, pin),
    [result.choices, pin],
  );
  const menu = useMemo(
    () => buildSourceMenu(result.choices, resolved),
    [result.choices, resolved],
  );

  const onSelectRef = useRef(onSelectMediaSource);
  onSelectRef.current = onSelectMediaSource;

  /**
   * Apply the resolved selection once per question.
   *
   * The token is the question: this title, under this policy, with this pin. A source picked by
   * hand in the Versions menu has to survive every re-render, so the same question is never asked
   * twice — but changing the policy or the pin genuinely is a new question and deserves a new
   * answer.
   */
  const appliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!result.data || !pinKey) return;
    const token = `${pinKey}:${result.policy}:${pin?.node ?? AUTO_KEY}`;
    if (appliedRef.current === token) return;

    const selected = resolved.selected;
    if (!selected) return;
    appliedRef.current = token;
    if (selected.mediaSourceId === currentMediaSourceId) return;
    onSelectRef.current?.(selected.mediaSourceId);
  }, [result.data, result.policy, resolved, pin, pinKey, currentMediaSourceId]);

  const choose = useCallback(
    (key: string) => {
      if (!pinKey) return;

      if (key === AUTO_KEY) {
        clearSourcePin(pinKey);
        setPin(undefined);
        const target = resolved.autoChoice;
        if (target && target.mediaSourceId !== currentMediaSourceId) {
          onSelectRef.current?.(target.mediaSourceId);
        }

        return;
      }

      const target = result.choices.find((c) => c.mediaSourceId === key);
      if (!target || target.disabled) return;

      const next: Omit<SourcePin, "updatedAt"> = {
        node: target.node,
        nodeName: target.nodeName,
        ...(target.fileHash ? { fileHash: target.fileHash } : {}),
      };
      rememberSourcePin(pinKey, next);
      setPin({ ...next, updatedAt: Date.now() });
      if (target.mediaSourceId !== currentMediaSourceId) {
        onSelectRef.current?.(target.mediaSourceId);
      }
    },
    [pinKey, resolved.autoChoice, result.choices, currentMediaSourceId],
  );

  return {
    ...result,
    resolved,
    menu,
    labels,
    label: selectionLabel(resolved, t("player.source.auto")),
    autoTarget: formatAutoTarget(resolved.autoChoice, labels),
    choose,
  };
};
