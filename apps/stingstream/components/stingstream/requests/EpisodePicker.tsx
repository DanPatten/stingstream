import { getStingStreamApiBaseUrl } from "@stingstream/api-client";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Button } from "@/components/Button";
import { Text } from "@/components/common/Text";
import { FilterChip } from "@/components/filters/FilterChip";
import { apiAtom } from "@/providers/JellyfinProvider";
import { reportSessionExpired } from "@/utils/sessionExpiry";

export function EpisodePicker({
  tmdbId,
  tvdbId,
  total,
  value,
  onChange,
}: {
  tmdbId: number;
  tvdbId: number;
  total: number;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const { t } = useTranslation();
  const api = useAtomValue(apiAtom);
  const [season, setSeason] = useState(1);
  const query = useQuery({
    queryKey: ["request-episodes", api?.basePath, tmdbId, tvdbId, season],
    enabled: !!api,
    queryFn: async () => {
      const res = await fetch(
        `${getStingStreamApiBaseUrl(api!.basePath)}/requests/episodes?tmdbId=${tmdbId}&tvdbId=${tvdbId}&season=${season}`,
        {
          headers: {
            Authorization: `MediaBrowser Token="${api!.accessToken}"`,
          },
        },
      );
      if (res.status === 401) reportSessionExpired();
      if (!res.ok) throw new Error(t("requests.episodes_unavailable"));
      const rows = (await res.json()) as Record<string, unknown>[];
      return rows.map((row) => ({
        key: String(row.key ?? row.Key),
        name: String(row.name ?? row.Name),
        number: Number(row.number ?? row.Number),
      }));
    },
  });
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {Array.from({ length: total }, (_, i) => i + 1).map((number) => (
          <FilterChip
            key={number}
            label={t("requests.season_number", { number })}
            active={season === number}
            onPress={() => setSeason(number)}
          />
        ))}
      </View>
      {query.isLoading ? <Text>{t("common.loading")}</Text> : null}
      {query.isError ? (
        <Button variant='ghost' onPress={() => void query.refetch()}>
          {t("common.retry")}
        </Button>
      ) : null}
      {query.data?.length === 0 ? (
        <Text>{t("requests.episodes_unavailable")}</Text>
      ) : null}
      {query.data?.map((episode) => (
        <FilterChip
          key={episode.key}
          label={`${episode.number}. ${episode.name}`}
          active={value.includes(episode.key)}
          onPress={() =>
            onChange(
              value.includes(episode.key)
                ? value.filter((key) => key !== episode.key)
                : [...value, episode.key],
            )
          }
        />
      ))}
    </View>
  );
}
