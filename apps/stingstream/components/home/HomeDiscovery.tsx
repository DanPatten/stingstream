import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { MyRequestsSection } from "@/components/stingstream/requests/MyRequestsSection";
import { RequestableRow } from "@/components/stingstream/requests/RequestableRow";
import useRouter from "@/hooks/useAppRouter";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import {
  DEFAULT_REQUEST_FILTERS,
  requestAsSearchResult,
  useRequestDiscover,
  useRequests,
} from "@/lib/stingstream/requests";

export function HomeDiscovery() {
  const { t } = useTranslation();
  const router = useRouter();
  const { gutter } = useBreakpoint();
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
  return (
    <View style={{ gap: 24 }}>
      <RequestableRow
        title={t("home.requested_ready")}
        results={ready}
        loading={mine.isLoading}
      />
      <View style={{ paddingHorizontal: gutter }}>
        <MyRequestsSection
          variant='row'
          onSeeAll={() =>
            router.push({ pathname: "/requests", params: { tab: "mine" } })
          }
        />
      </View>
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
