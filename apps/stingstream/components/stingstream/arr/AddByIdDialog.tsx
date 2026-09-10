import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Dialog } from "@/components/common/Dialog";
import { Input } from "@/components/common/Input";
import { useAddMovie, useAddSeries } from "@/lib/stingstream/hooks";
import { SegmentedControlBar } from "../shared/SegmentedControl";

/**
 * Add a title this server's search cannot find, by its provider id.
 *
 * The escape hatch, and the only reason it exists: a lookup needs a metadata provider to answer,
 * and when it will not, a TMDB or TVDB id is the one thing that still identifies a film. It used
 * to sit at the bottom of a settings screen's add form, next to a search box that duplicated
 * Requests. The form went with the screen; this stayed, moved to the place a search has just come
 * back empty, which is when somebody wants it.
 *
 * Administrators only, because it puts a title straight into the manager without a request row,
 * an approval or the group dedupe. That is the point: it is for the title nothing else can reach.
 *
 * Monitored and searched immediately, with the node's default quality profile. The profile is a
 * per-title choice made afterwards, on the title's own page, rather than a decision imposed on
 * somebody who is here because a search failed.
 */
export function AddByIdDialog({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<"movie" | "series">("movie");
  const [value, setValue] = useState("");
  const addMovie = useAddMovie();
  const addSeries = useAddSeries();
  const isMovie = kind === "movie";
  const pending = addMovie.isPending || addSeries.isPending;

  const submit = async () => {
    const id = Number.parseInt(value, 10);
    if (!Number.isFinite(id) || id <= 0) {
      toast.error(
        isMovie
          ? t("manage.enter_valid_tmdb_id")
          : t("manage.enter_valid_tvdb_id"),
      );
      return;
    }
    try {
      const added = isMovie
        ? await addMovie.mutateAsync({ tmdbId: id, searchOnAdd: true })
        : await addSeries.mutateAsync({ tvdbId: id, searchOnAdd: true });
      toast.success(t("manage.added_toast", { title: added.title ?? `#${id}` }));
      setValue("");
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("manage.add_error"));
    }
  };

  return (
    <Dialog
      visible={visible}
      onClose={onClose}
      title={t("requests.add_by_id_title")}
      actions={[
        {
          label: t("manage.add_action"),
          onPress: () => void submit(),
          loading: pending,
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
