import { Ionicons } from "@expo/vector-icons";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Linking,
  Platform,
  Pressable,
  View,
  type ViewStyle,
} from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { CardArtwork } from "@/components/cards/CardArtwork";
import { Dialog } from "@/components/common/Dialog";
import { FormError } from "@/components/common/FormError";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { getItemNavigation } from "@/components/common/TouchableItemRouter";
import { radius } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useTheme } from "@/hooks/useTheme";
import { useArrTitle } from "@/lib/stingstream/hooks";
import {
  imdbUrl,
  type MemberRequest,
  RequestFinishedError,
  type RequestReason,
  type RequestSearchResult,
  requestTitle,
  searchAction,
  toRequestCard,
  useCanApproveRequests,
  useCreateRequest,
  useDeleteRequest,
  useSetRequestSeasons,
} from "@/lib/stingstream/requests";
import { QualityProfileRow } from "../arr/QualityProfileRow";
import { confirmDestructive } from "../shared/confirm";
import { ReasonPicker } from "./ReasonPicker";
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

/** The same gold star the tiles and the details page use. See `components/cards/Card.tsx`. */
const RATING_STAR = "#E0B34A";

const isWeb = Platform.OS === "web";

/**
 * Which seasons, and a "held by …" notice when a member already has it.
 *
 * **Opened from a row only when there is something to choose, and from a poster always.** It used
 * to open for anything, and that was wrong for a *row*: the sheet was the row it was opened from,
 * drawn again at a larger size, with a second button also called Request, so asking for a movie
 * meant pressing Request twice to say one thing. A row still submits a movie directly.
 *
 * A poster is the opposite case. A tile is artwork and a title, the overview is not on it, and the
 * press target is the whole card rather than a button labelled with what it will do, so a tap
 * that spent a group download outright would be one mis-aimed thumb away on a grid of sixty. From
 * the catalogue the sheet is where a movie is read and then asked for, which is also why the season
 * picker is drawn only for a series: a movie has nothing to pick, and a row of twenty numbered
 * squares over one is an invitation to wonder what it means.
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
  const router = useRouter();
  const [shown, setShown] = useState<RequestSearchResult | null>(null);
  const [seasons, setSeasons] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<RequestReason | null>(null);
  const create = useCreateRequest();
  const isAdmin = useCanApproveRequests();
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
    setReason(null);
  }, [openedFor, openedSeasons, openedExisting, openedExistingSeasons]);

  // Before the early return: hooks cannot be called conditionally, and `useArrTitle` switches its
  // own queries off when it has nothing to ask about.
  const providerId = result
    ? result.kind === "series"
      ? result.tvdbId
      : result.tmdbId
    : 0;
  const managed = useArrTitle(
    result?.kind === "series" ? "series" : "movie",
    providerId || undefined,
    isAdmin && !!result,
  );

  if (!shown) return null;

  const total = seasonTotal(shown);
  const action = searchAction(shown);
  const isSeries = shown.kind === "series";
  // Editing needs *both* halves to still agree that there is a request to edit. `existing` comes
  // from the member's own list and `action` from the node's annotation on the search result, and a
  // request can finish while the sheet is open -- a node with no indexer fails one within seconds.
  // Deciding on `existing` alone sent a PUT to a request that had since failed, and the node
  // rightly answered "This request has already finished." Falling back to creating is what the row
  // behind the sheet is offering by then anyway: it reads "Request again".
  const editingNow = editing !== null && action.intent === "manage";
  // The group already has it and there is no open request to edit, so the only sensible reading of
  // pressing the button is "I know, and I want something done about it anyway". The sheet asks
  // which of the three things, and will not submit until it has an answer.
  const needsReason = !editingNow && action.intent === "duplicate";
  const heldAlready =
    shown.availableInGroup || shown.requestState === "available";
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
    // Before the season branches on purpose. "Request all" on a title the library already has
    // describes the wrong thing entirely: nothing is being asked for wholesale, one specific
    // complaint is being made about a copy that exists.
    if (needsReason) return t("requests.request_anyway");
    if (nothingChosen) return t("requests.request_button");
    // Editing says Save, not Request: the request exists, and "Request all" on a row that is
    // already awaiting approval would read as asking for it a second time.
    if (editingNow) return t("requests.save_button");
    // A movie has no seasons, so it has only ever meant one thing. Below the editing case on
    // purpose: a movie whose request is open is being changed, not asked for again.
    if (!isSeries) return t("requests.request_button");
    if (seasons.length === total) return t("requests.request_all_seasons");
    return t("requests.request_n_seasons", { count: seasons.length });
  };

  /**
   * Open the copy the library already has.
   *
   * Closes the sheet first: leaving it stacked over the title somebody just asked to watch means
   * dismissing a dialog about requesting a thing they are now looking at.
   */
  const playExisting = (itemId: string) => {
    onClose();
    // Through the app's own router rather than a path written here, so a title opened from a
    // request lands exactly where one opened from search or the library does.
    const target = getItemNavigation(
      { Id: itemId, Type: isSeries ? "Series" : "Movie" } as BaseItemDto,
      "",
    );
    // The cast every caller of this helper uses: its return is a union of every route shape in the
    // app, which expo-router's own overloads cannot narrow back down.
    router.push(target as never);
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
        // Kept on the request: the search result they came from is gone by the time anybody edits
        // it, and nothing else can answer either question later.
        overview: shown.overview,
        seasonCount: shown.seasonCount,
        reason: reason ?? undefined,
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
        // Delete sits at the far end from the submit: it is the way *out* of the request, not a
        // second way to confirm it, and a destructive control next to the one everybody means to
        // press is how people press the wrong one.
        //
        // Offered for any request that exists, not only one still open — the other half of the
        // inconsistency the row had. A failed request could be deleted from its row and not from
        // its own sheet, so the two disagreed about what could be done to the same thing.
        ...(editing
          ? [
              {
                // Named for what it deletes. On a dialog that is already about one title a bare
                // "Delete" is the shortest label that still leaves the reader checking what it
                // means, and the thing it deletes is the request, not the movie.
                label: t("requests.delete_action"),
                // `danger`, like the same button on My requests. It was ghost, on the idea that
                // playing it down keeps it away from the one everybody means to press -- but a
                // destructive control that looks ordinary is the one people press by accident, and
                // it is the distance from the submit rather than the colour that keeps it clear.
                variant: "danger" as const,
                icon: "delete" as const,
                testID: "requests-delete",
                onPress: withdraw,
                disabled: busy,
                loading: remove.isPending,
              },
            ]
          : []),
        // No Cancel. The dialog closes on its own dismiss — the X, the scrim, Escape — so a button
        // for it is a third control competing with the two that actually do something.
        {
          label: submitLabel(),
          testID: "requests-submit",
          onPress: submit,
          // A reason is required rather than optional. Without one the node cannot tell this from
          // asking for something the group already has, which it would answer by doing nothing.
          disabled:
            action.disabled ||
            nothingChosen ||
            busy ||
            (needsReason && !reason),
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
          <View style={{ flex: 1, gap: 8 }}>
            {/*
              The same three facts the tile carries, in the same order: what it is, how long it is,
              and what it scored. The score is the way out to IMDb, exactly as it is on the tile —
              a reader who has opened the sheet to decide is the one most likely to want it.
            */}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 10,
              }}
            >
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 5 }}
              >
                <Ionicons
                  name={shown.kind === "series" ? "tv-outline" : "film-outline"}
                  size={13}
                  color={color.text.tertiary}
                />
                <Text variant='caption' tone='tertiary'>
                  {shown.kind === "series"
                    ? total > 0
                      ? t("requests.season_count", { count: total })
                      : t("requests.kind_series")
                    : t("requests.kind_movie")}
                </Text>
              </View>

              {shown.rating != null && shown.rating > 0 ? (
                <Pressable
                  accessibilityRole='link'
                  accessibilityLabel={`${shown.rating.toFixed(1)} out of 10 on IMDb`}
                  onPress={() => void Linking.openURL(imdbUrl(shown))}
                  style={({ hovered }: { hovered?: boolean }) => [
                    {
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 5,
                      opacity: hovered ? 0.7 : 1,
                    },
                    isWeb ? ({ cursor: "pointer" } as ViewStyle) : null,
                  ]}
                >
                  <Ionicons name='star' size={13} color={RATING_STAR} />
                  <Text variant='caption' tone='secondary'>
                    {shown.rating.toFixed(1)}
                  </Text>
                  <Icon name='openExternal' size={11} tone='tertiary' />
                </Pressable>
              ) : null}
            </View>

            {shown.overview ? (
              <Text variant='body' tone='secondary' numberOfLines={7}>
                {shown.overview}
              </Text>
            ) : null}
          </View>
        </View>

        {heldAlready ? (
          <View
            style={{
              gap: 10,
              padding: 12,
              borderRadius: radius.md,
              backgroundColor: color.bg["2"],
            }}
          >
            <View
              style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}
            >
              <Icon
                name='info'
                tone='accent'
                size={16}
                style={{ marginTop: 1 }}
              />
              <Text variant='caption' tone='secondary' style={{ flex: 1 }}>
                {shown.holders.length > 0
                  ? t("requests.held_by", {
                      holders: shown.holders.join(", "),
                    })
                  : t("requests.duplicate_intro")}
              </Text>
            </View>
            {/*
              Somebody told they already have something should be one press from watching it.
              Absent when the copy has not resolved to an item here yet, which happens for a few
              seconds after a peer first announces one: naming the holder with no link is still
              better than a button that goes nowhere.
            */}
            {shown.localItemId ? (
              <Button
                variant='secondary'
                size='sm'
                onPress={() => playExisting(shown.localItemId!)}
              >
                {t("requests.play_existing")}
              </Button>
            ) : null}
          </View>
        ) : null}

        {needsReason ? (
          <ReasonPicker kind={shown.kind} value={reason} onChange={setReason} />
        ) : null}

        {isSeries ? (
          <SeasonPicker value={seasons} onChange={setSeasons} total={total} />
        ) : null}

        {/*
          Quality is the one thing here that is about the *request*: how good a copy has to be
          before it counts as answered. Monitoring and the two removals were on this sheet for a
          while, merged in from "Manage on this server", and they are things done to a library item
          — which a request is not. Dan: *"this is a request not a libary item."* They live on the
          title's own page, where the title is.

          Only when this node's manager tracks it: there is no profile to set on a movie no manager
          here has heard of.
        */}
        {managed.row ? (
          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: color.border.subtle,
              marginTop: 16,
              paddingTop: 4,
            }}
          >
            <QualityProfileRow
              kind={shown.kind === "series" ? "series" : "movie"}
              providerId={providerId}
              title={requestTitle(shown)}
              profileName={managed.profileName}
              active={!!result}
            />
          </View>
        ) : null}

        <FormError message={error} />
      </View>
    </Dialog>
  );
}
