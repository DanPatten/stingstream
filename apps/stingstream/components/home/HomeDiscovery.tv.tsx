import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { TVRequestableRow } from "@/components/tv/TVRequestableRow";
import { useScaledTVSizes } from "@/constants/TVSizes";
import { useReadyRequests } from "@/hooks/useReadyRequests";
import {
  DEFAULT_REQUEST_FILTERS,
  useRequestDiscover,
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
  const padding = sizes.layout.contentInsetLeft;
  return (
    <View style={{ paddingHorizontal: padding }}>
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

export function HomeReadyRequests() {
  const { t } = useTranslation();
  const ready = useReadyRequests();
  const sizes = useScaledTVSizes();
  return (
    <View style={{ paddingHorizontal: sizes.layout.contentInsetLeft }}>
      <TVRequestableRow
        title={t("home.requested_ready")}
        results={ready.data}
        horizontalPadding={sizes.layout.contentInsetLeft}
      />
    </View>
  );
}
