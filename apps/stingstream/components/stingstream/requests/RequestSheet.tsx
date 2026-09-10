import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Dialog } from "@/components/common/Dialog";
import { FormError } from "@/components/common/FormError";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { radius } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import {
  type RequestSearchResult,
  requestTitle,
  searchAction,
  useCreateRequest,
} from "@/lib/stingstream/requests";
import { requestMadeToast } from "./requestMadeToast";
import {
  allSeasons,
  SeasonPicker,
  seasonsForRequest,
  seasonTotal,
} from "./SeasonPicker";

/**
 * Which seasons, and a "held by …" notice when a member already has it.
 *
 * **TV shows only.** It used to open for anything: poster, year, overview, a season picker for a
 * series, and a Request button. For a movie that was the row it was opened from, drawn again at a
 * larger size, with a second button also called Request — asking for a film meant pressing Request
 * twice to say one thing. `FindSection` submits a movie straight from its row now, and opens this
 * only when there is genuinely something to choose.
 *
 * The poster and overview went with it for the same reason: the row behind the sheet is already
 * showing both, and repeating them here was most of what made the sheet read as a duplicate rather
 * than as a question.
 *
 * `Dialog` already decides card-on-web-wide / bottom-sheet-on-phone (`components/common/Dialog.tsx`),
 * so this component is only ever the title, the body and the actions; nothing here checks the
 * breakpoint.
 *
 * `result` doubles as the visibility flag (`null` closes it) and the content, which would flash
 * the sheet empty for the length of the close animation if the body read `result` directly — so
 * the body reads the last non-null result instead, and only `visible` follows `result` itself.
 */
export function RequestSheet({
  result,
  onClose,
}: {
  result: RequestSearchResult | null;
  onClose: () => void;
}) {
  const { color } = useTheme();
  const { t } = useTranslation();
  const [shown, setShown] = useState<RequestSearchResult | null>(null);
  const [seasons, setSeasons] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const create = useCreateRequest();

  useEffect(() => {
    if (result) setShown(result);
  }, [result]);

  // A fresh sheet for a fresh title: leftover seasons or an old error from the last one asked
  // about must not carry over. Keyed on the item key rather than the whole object — `result` is a
  // fresh array element every time Discover's search results refetch, and a background refetch
  // while the sheet is open for the same title must not wipe out seasons the user already ticked.
  //
  // It opens with every season ticked, because a request for a show is almost always a request for
  // the whole show. `seasonsForRequest` turns that back into the empty list the node reads as "all
  // of it", so the common case still takes Sonarr's own monitor-all path rather than arriving as
  // an enumeration.
  //
  // Both deps are primitives off `result` rather than `result` itself, which is a fresh array
  // element on every refetch and would re-run this — wiping the ticks mid-thought.
  const openedFor = result?.itemKey;
  const openedSeasons = result?.seasonCount;
  useEffect(() => {
    setSeasons(allSeasons(seasonTotal({ seasonCount: openedSeasons })));
    setError(null);
  }, [openedFor, openedSeasons]);

  if (!shown) return null;

  const total = seasonTotal(shown);
  const action = searchAction(shown);
  // Nothing ticked is not a request. There is no way to say "no seasons" on the wire — an empty
  // list means every season — so the button waits rather than sending the opposite of the screen.
  const nothingChosen = seasons.length === 0;

  /**
   * The button says what pressing it will ask for.
   *
   * A bare "Request" under a row of chips leaves the reader checking the chips again to find out
   * what they are about to get, which is the doubt the chips were meant to remove. Three shapes,
   * because "Request 1 seasons" is not English and "Request 6 seasons" hides that six *is* all of
   * them.
   */
  const submitLabel = () => {
    if (action.disabled) return action.label;
    if (nothingChosen) return t("requests.request_button");
    if (seasons.length === total)
      return t("requests.request_all_seasons", { count: total });
    if (seasons.length === 1)
      return t("requests.request_one_season", { n: seasons[0] });
    return t("requests.request_n_seasons", { count: seasons.length });
  };

  const submit = async () => {
    setError(null);
    try {
      const made = await create.mutateAsync({
        tmdbId: shown.tmdbId || undefined,
        tvdbId: shown.tvdbId || undefined,
        seasons: seasonsForRequest(seasons, total),
        title: shown.title,
        year: shown.year,
        posterUrl: shown.posterUrl,
      });
      requestMadeToast(made, t);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Dialog
      visible={!!result}
      onClose={onClose}
      title={requestTitle(shown)}
      dismissible={!create.isPending}
      actions={[
        {
          label: t("common.cancel"),
          variant: "ghost",
          onPress: onClose,
          disabled: create.isPending,
        },
        {
          label: submitLabel(),
          testID: "requests-submit",
          onPress: submit,
          disabled: action.disabled || nothingChosen,
          loading: create.isPending,
        },
      ]}
    >
      <View testID='requests-sheet'>
        {shown.availableInGroup && shown.holders.length > 0 ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "flex-start",
              gap: 8,
              padding: 12,
              borderRadius: radius.md,
              backgroundColor: color.bg["2"],
            }}
          >
            <Icon
              name='info'
              tone='accent'
              size={16}
              style={{ marginTop: 1 }}
            />
            <Text variant='caption' tone='secondary' style={{ flex: 1 }}>
              {t("requests.held_by", { holders: shown.holders.join(", ") })}
            </Text>
          </View>
        ) : null}

        <SeasonPicker value={seasons} onChange={setSeasons} total={total} />

        <FormError message={error} />
      </View>
    </Dialog>
  );
}
