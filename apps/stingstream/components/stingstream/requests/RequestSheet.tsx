import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { CardArtwork } from "@/components/cards/CardArtwork";
import { Dialog } from "@/components/common/Dialog";
import { FormError } from "@/components/common/FormError";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { radius } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import {
  type MemberRequest,
  RequestFinishedError,
  type RequestSearchResult,
  requestTitle,
  searchAction,
  toRequestCard,
  useCreateRequest,
  useDeleteRequest,
  useSetRequestSeasons,
} from "@/lib/stingstream/requests";
import { confirmDestructive } from "../shared/confirm";
import { requestMadeToast } from "./requestMadeToast";
import {
  allSeasons,
  SeasonPicker,
  seasonsForRequest,
  seasonTotal,
} from "./SeasonPicker";

/** Big enough to recognise a poster by, which the row's 92px thumbnail is not always. */
const POSTER_WIDTH = 96;
const POSTER_HEIGHT = Math.round(POSTER_WIDTH * 1.5);

/**
 * Which seasons, and a "held by …" notice when a member already has it.
 *
 * **TV shows only.** It used to open for anything: poster, year, overview, a season picker for a
 * series, and a Request button. For a movie that was the row it was opened from, drawn again at a
 * larger size, with a second button also called Request — asking for a film meant pressing Request
 * twice to say one thing. `FindSection` submits a movie straight from its row now, and opens this
 * only when there is genuinely something to choose.
 *
 * The poster and the blurb went with it for a while, on the reasoning that the row behind the sheet
 * already shows both. They are back: the sheet covers that row, and a title, a year and six numbered
 * squares are not enough to be sure you are about to ask for the right one of six similarly named
 * shows. Bigger than the row's thumbnail, and the overview runs to seven lines rather than two.
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
  existing = null,
  onClose,
}: {
  result: RequestSearchResult | null;
  /**
   * The open request this title already has, when it has one.
   *
   * Turns the sheet from "ask for this" into "change what you asked for": the seasons start where
   * the request currently stands, submitting replaces them rather than making a second request, and
   * a Withdraw action appears beside Cancel.
   */
  existing?: MemberRequest | null;
  onClose: () => void;
}) {
  const { color } = useTheme();
  const { t } = useTranslation();
  const [shown, setShown] = useState<RequestSearchResult | null>(null);
  const [seasons, setSeasons] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const create = useCreateRequest();
  const setSeasonsOn = useSetRequestSeasons();
  const remove = useDeleteRequest();
  const editing = existing ?? null;

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
  // Editing starts from what the request covers today, not from everything: the point of opening it
  // is to see and change that. An existing row with an empty season list means every season, which
  // is the same thing a fresh sheet starts on.
  const openedExisting = editing?.id;
  const openedExistingSeasons = editing?.seasons?.join(",");
  useEffect(() => {
    const total = seasonTotal({ seasonCount: openedSeasons });
    const current = openedExistingSeasons
      ? openedExistingSeasons.split(",").map(Number)
      : [];
    setSeasons(current.length > 0 ? current : allSeasons(total));
    setError(null);
  }, [openedFor, openedSeasons, openedExisting, openedExistingSeasons]);

  if (!shown) return null;

  const total = seasonTotal(shown);
  const action = searchAction(shown);
  // Editing needs *both* halves to still agree that there is a request to edit. `existing` comes
  // from the member's own list and `action` from the node's annotation on the search result, and a
  // request can finish while the sheet is open -- a node with no indexer fails one within seconds.
  // Deciding on `existing` alone sent a PUT to a request that had since failed, and the node
  // rightly answered "This request has already finished." Falling back to creating is what the row
  // behind the sheet is offering by then anyway: it reads "Request again".
  const editingNow = editing !== null && action.intent === "manage";
  // Nothing ticked is not a request. There is no way to say "no seasons" on the wire — an empty
  // list means every season — so the button waits rather than sending the opposite of the screen.
  const nothingChosen = seasons.length === 0;

  /**
   * The button says what pressing it will ask for.
   *
   * A bare "Request" under a row of squares leaves the reader checking the squares again to find
   * out what they are about to get, which is the doubt the squares were meant to remove. Short,
   * because the sheet is narrow and the button sits beside Cancel: "Request all" or "Request (3)",
   * not a sentence naming every season.
   */
  const submitLabel = () => {
    if (action.disabled) return action.label;
    if (nothingChosen) return t("requests.request_button");
    // Editing says Save, not Request: the request exists, and "Request all" on a row that is
    // already awaiting approval would read as asking for it a second time.
    if (editingNow) return t("requests.save_button");
    if (seasons.length === total) return t("requests.request_all_seasons");
    return t("requests.request_n_seasons", { count: seasons.length });
  };

  const submit = async () => {
    setError(null);
    try {
      // Replacing, not asking again. `useCreateRequest` on an open request *grows* its season list,
      // because a second person asking for season 4 means "and season 4" -- which is the wrong verb
      // for somebody editing their own request down to fewer seasons.
      const wanted = seasonsForRequest(seasons, total);
      if (editingNow && editing) {
        try {
          await setSeasonsOn.mutateAsync({ id: editing.id, seasons: wanted });
          toast.success(t("requests.toast_saved", { title: shown.title }));
          onClose();
          return;
        } catch (err) {
          // Anything but "it finished under you" is a real failure and is shown. That one is not:
          // the row moved on while the sheet was open, and asking again reopens the same row with
          // the seasons that were just chosen -- which is what Save meant.
          if (!(err instanceof RequestFinishedError)) throw err;
        }
      }
      const made = await create.mutateAsync({
        tmdbId: shown.tmdbId || undefined,
        tvdbId: shown.tvdbId || undefined,
        seasons: wanted,
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

  /** Drop the request outright. Confirmed, because asking again goes back through approval. */
  const withdraw = async () => {
    if (!editing) return;
    const title = requestTitle(shown);
    const ok = await confirmDestructive(
      t("requests.delete_confirm_title", { title }),
      t("requests.delete_confirm_detail"),
      t("common.delete"),
    );
    if (!ok) return;
    setError(null);
    try {
      await remove.mutateAsync(editing.id);
      toast.success(t("requests.delete_success", { title }));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const busy = create.isPending || setSeasonsOn.isPending || remove.isPending;

  return (
    <Dialog
      visible={!!result}
      onClose={onClose}
      title={requestTitle(shown)}
      dismissible={!busy}
      actions={[
        // Withdraw sits with Cancel rather than beside the submit: it is the way *out* of the
        // request, not a second way to confirm it, and a destructive control next to the one
        // everybody means to press is how people press the wrong one.
        ...(editingNow && editing
          ? [
              {
                label: t("common.delete"),
                variant: "ghost" as const,
                testID: "requests-delete",
                onPress: withdraw,
                disabled: busy,
                loading: remove.isPending,
              },
            ]
          : []),
        {
          label: t("common.cancel"),
          variant: "ghost" as const,
          onPress: onClose,
          disabled: busy,
        },
        {
          label: submitLabel(),
          testID: "requests-submit",
          onPress: submit,
          disabled: action.disabled || nothingChosen || busy,
          loading: create.isPending || setSeasonsOn.isPending,
        },
      ]}
    >
      <View testID='requests-sheet'>
        <View style={{ flexDirection: "row", gap: 16, marginBottom: 16 }}>
          <CardArtwork
            card={toRequestCard(shown)}
            width={POSTER_WIDTH}
            height={POSTER_HEIGHT}
            cornerRadius={radius.md}
          />
          {/* No year here: the dialog's own title is `requestTitle`, which already ends in it. */}
          <View style={{ flex: 1 }}>
            {shown.overview ? (
              <Text variant='body' tone='secondary' numberOfLines={7}>
                {shown.overview}
              </Text>
            ) : null}
          </View>
        </View>

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
