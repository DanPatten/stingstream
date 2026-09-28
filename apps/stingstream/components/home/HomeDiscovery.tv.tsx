import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { TVRequestableRow } from "@/components/tv/TVRequestableRow";
import { useScaledTVSizes } from "@/constants/TVSizes";
import {
  DEFAULT_REQUEST_FILTERS,
  requestAsSearchResult,
  useRequestDiscover,
  useRequests,
} from "@/lib/stingstream/requests";

export function HomeDiscovery() {
  const { t } = useTranslation();
  const sizes = useScaledTVSizes();
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
  const mine = useRequests({ mine: true });
  const ready = mine.data
    ?.filter((request) => request.state === "available" && request.localItemId)
    .map(requestAsSearchResult);
  const padding = sizes.layout.contentInsetLeft;
  return (
    <View style={{ paddingHorizontal: padding }}>
      <TVRequestableRow
        title={t("home.requested_ready")}
        results={ready}
        horizontalPadding={padding}
      />
      <TVRequestableRow
        title={t("home.trending_movies")}
        results={movies.data?.results}
        horizontalPadding={padding}
      />
      <TVRequestableRow
        title={t("home.trending_shows")}
        results={shows.data?.results}
        horizontalPadding={padding}
      />
    </View>
  );
}
