import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Dialog } from "@/components/common/Dialog";
import { Input } from "@/components/common/Input";
import { useStingStreamClient } from "@/lib/stingstream/client";
import type { LookupResult } from "@/lib/stingstream/hooks";
import { useCreateRequest } from "@/lib/stingstream/requests";
import { requestMadeToast } from "../requests/requestMadeToast";
import { SegmentedControlBar } from "../shared/SegmentedControl";

/**
 * Ask for a title the search cannot name, by its provider id.
 *
 * The escape hatch, and the only reason it exists: search-by-title needs a metadata provider to
 * answer with something recognisable, and when it will not, a TMDB or TVDB id is the one thing
 * that still identifies a film. `?term=tmdb:550` is a lookup the managers *can* always answer, so
 * this resolves the id to a real title first and then asks for it exactly as Find does.
 *
 * **It files a request rather than adding straight to the manager**, and that is the whole
 * difference from the settings form this replaced. A direct add left a title tracked by the server
 * and named nowhere in the app: no request row, no library entry until something downloads, and so
 * nothing to press to undo it. Going through Requests means it appears in My requests the moment
 * it is asked for, with the group dedupe and the manage actions that row carries
 * (`arr/ManageTitleAction.tsx`) — and for an administrator, who is always auto-approved, the grab
 * starts just as immediately as the direct add did.
 *
 * Administrators only, because it is offered from an empty state only they see. Nothing here needs
 * elevation, though: an ordinary request by id would work the same.
 */
export function AddByIdDialog({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const client = useStingStreamClient();
  const create = useCreateRequest();
  const [kind, setKind] = useState<"movie" | "series">("movie");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const isMovie = kind === "movie";

  const submit = async () => {
    const id = Number.parseInt(value.trim(), 10);
    if (!Number.isFinite(id) || id <= 0) {
      toast.error(
        isMovie
          ? t("manage.enter_valid_tmdb_id")
          : t("manage.enter_valid_tvdb_id"),
      );
      return;
    }
    if (!client) return;
    setBusy(true);
    try {
      // The arr's own lookup understands the `tmdb:`/`tvdb:` prefix, which is what makes this
      // work when the same lookup answers a typed title with nothing.
      const term = `${isMovie ? "tmdb" : "tvdb"}:${id}`;
      const { data, error } = isMovie
        ? await client.GET("/stingstream/api/v1/movies/lookup", {
            params: { query: { term } },
          })
        : await client.GET("/stingstream/api/v1/series/lookup", {
            params: { query: { term } },
          });
      if (error) throw error;
      const found = ((data ?? []) as LookupResult[])[0];
      if (!found) {
        toast.error(t("requests.add_by_id_not_found"));
        return;
      }
      const made = await create.mutateAsync({
        tmdbId: isMovie ? id : undefined,
        tvdbId: isMovie ? undefined : id,
        title: found.Title,
        year: found.Year,
        posterUrl: found.PosterUrl,
      });
      requestMadeToast(made, t);
      setValue("");
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      visible={visible}
      onClose={onClose}
      title={t("requests.add_by_id_title")}
      actions={[
        {
          label: t("requests.request_button"),
          onPress: () => void submit(),
          loading: busy,
          disabled: value.trim().length === 0,
          testID: "add-by-id-submit",
        },
      ]}
    >
      <View testID='add-by-id' style={{ gap: 12 }}>
        <SegmentedControlBar
          segments={[
            { key: "movie", label: t("manage.movie_manager_label") },
            { key: "series", label: t("manage.series_manager_label") },
          ]}
          value={kind}
          onChange={(v) => setKind(v as "movie" | "series")}
        />
        <Input
          placeholder={
            isMovie
              ? t("requests.add_by_id_tmdb_placeholder")
              : t("requests.add_by_id_tvdb_placeholder")
          }
          keyboardType='number-pad'
          autoCapitalize='none'
          autoCorrect={false}
          value={value}
          onChangeText={setValue}
          onSubmitEditing={() => void submit()}
        />
      </View>
    </Dialog>
  );
}
