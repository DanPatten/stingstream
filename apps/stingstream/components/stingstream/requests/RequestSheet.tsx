import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { CardArtwork } from "@/components/cards/CardArtwork";
import { Dialog } from "@/components/common/Dialog";
import { FormError } from "@/components/common/FormError";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { radius, tokens } from "@/constants/theme";
import {
  type RequestSearchResult,
  requestTitle,
  searchAction,
  toRequestCard,
  useCreateRequest,
} from "@/lib/stingstream/requests";
import { SeasonPicker } from "./SeasonPicker";

const POSTER_WIDTH = 96;
const POSTER_HEIGHT = Math.round(POSTER_WIDTH * 1.5);

/**
 * Poster, overview, a "held by ..." notice when a member already has it, a season picker for a
 * series, and the Request button itself — everything Discover's card doesn't have room to say.
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
  useEffect(() => {
    setSeasons([]);
    setError(null);
  }, [result?.itemKey]);

  if (!shown) return null;

  const isSeries = shown.kind === "series";
  const action = searchAction(shown);

  const submit = async () => {
    setError(null);
    try {
      const made = await create.mutateAsync({
        tmdbId: shown.tmdbId || undefined,
        tvdbId: shown.tvdbId || undefined,
        seasons: isSeries ? seasons : undefined,
        title: shown.title,
        year: shown.year,
        posterUrl: shown.posterUrl,
      });
      // Three genuinely different outcomes, and calling all of them "requested" would hide the one
      // that matters: a title the group already had starts no download at all.
      if (made.state === "available") {
        toast.success(
          t("requests.toast_available", { title: requestTitle(made) }),
        );
      } else if (made.state === "pending") {
        toast.success(
          t("requests.toast_pending", { title: requestTitle(made) }),
        );
      } else {
        toast.success(
          t("requests.toast_requested", { title: requestTitle(made) }),
        );
      }
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
      // See `Dialog`'s own doc comment: the bottom sheet this would otherwise use cannot be
      // closed at all on a compact-width web build (Reanimated's exit animation, which the sheet's
      // dismiss depends on, fails to load there) — confirmed live: Cancel, a backdrop tap and
      // swipe-down all left it stuck open, blocking every screen navigated to afterwards. The
      // centred-card Modal closes reliably; native phones are unaffected and keep the sheet.
      forceModal
      actions={[
        {
          label: t("common.cancel"),
          variant: "ghost",
          onPress: onClose,
          disabled: create.isPending,
        },
        {
          label: action.disabled ? action.label : t("requests.request_button"),
          testID: "requests-submit",
          onPress: submit,
          disabled: action.disabled,
          loading: create.isPending,
        },
      ]}
    >
      <View testID='requests-sheet'>
        <View style={{ flexDirection: "row", gap: 16 }}>
          <CardArtwork
            card={toRequestCard(shown)}
            width={POSTER_WIDTH}
            height={POSTER_HEIGHT}
            cornerRadius={radius.md}
          />
          <View style={{ flex: 1 }}>
            {shown.year ? (
              <Text variant='caption' tone='secondary'>
                {shown.year}
              </Text>
            ) : null}
            {shown.overview ? (
              <Text
                variant='body'
                tone='secondary'
                numberOfLines={7}
                style={{ marginTop: 4 }}
              >
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
              marginTop: 16,
              padding: 12,
              borderRadius: radius.md,
              backgroundColor: tokens.color.bg["2"],
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

        {isSeries ? (
          <SeasonPicker value={seasons} onChange={setSeasons} />
        ) : null}

        <FormError message={error} />
      </View>
    </Dialog>
  );
}
