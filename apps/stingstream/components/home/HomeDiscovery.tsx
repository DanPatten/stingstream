import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { RequestableRow } from "@/components/stingstream/requests/RequestableRow";
import { useReadyRequests } from "@/hooks/useReadyRequests";
import {
  DEFAULT_REQUEST_FILTERS,
  useRequestDiscover,
} from "@/lib/stingstream/requests";

export function HomeDiscovery() {
  const { t } = useTranslation();
  const movies = useRequestDiscover({
    ...DEFAULT_REQUEST_FILTERS,
    kind: "movie",
    sortBy: ["trending"],
  });
  const shows = useRequestDiscover({
    ...DEFAULT_REQUEST_FILTERS,
    kind: "series",
    sortBy: ["trending"],
  });
  return (
    <View style={{ gap: 24 }}>
      <RequestableRow
        title={t("home.trending_movies")}
        results={movies.data?.results}
        loading={movies.isLoading}
      />
      <RequestableRow
        title={t("home.trending_shows")}
        results={shows.data?.results}
        loading={shows.isLoading}
      />
    </View>
  );
}

export function HomeReadyRequests() {
  const { t } = useTranslation();
  const ready = useReadyRequests();
  return (
    <RequestableRow
      title={t("home.requested_ready")}
      results={ready.data}
      loading={ready.isLoading}
    />
  );
}
