import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Button } from "@/components/Button";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { radius, space } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useTheme } from "@/hooks/useTheme";
import {
  indexerProblem,
  useIndexerHealth,
} from "@/lib/stingstream/indexerHealth";
import { useCanApproveRequests } from "@/lib/stingstream/requests";

/**
 * "Requests will not go anywhere yet."
 *
 * Search on this screen answers from TMDB, so it fills with results on a node that cannot fetch a
 * single one of them. Downloading being on only says a manager is running — it says nothing about
 * whether that manager has an indexer to ask. With none configured, or with every one of them
 * failing, a request is accepted, searched for nowhere, and never arrives; the only symptom is
 * silence, days later, on a screen that said nothing was wrong.
 *
 * A banner above the tabs rather than a screen instead of them, which is what `RequestsNotSetUp`
 * does for its own case. The difference is what the reader can still usefully do: with downloading
 * off, nothing on this screen works and there is no point drawing it. With no indexer, searching,
 * browsing and reading the queue all work, and a request made now starts working the moment an
 * indexer is added. Taking the screen away would be a bigger lie than leaving it.
 *
 * Administrators only, and it does not ask the node anything for anybody else: the fix is two
 * screens away in settings, and a member told about indexers has been handed a word from our
 * plumbing and nothing to do with it. They already have `requests.my_empty_detail` for the
 * symptom.
 */
export function IndexerNotice() {
  const { color } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const isAdmin = useCanApproveRequests();
  const { data } = useIndexerHealth(isAdmin);
  const problem = indexerProblem(data);

  if (!isAdmin || !problem) return null;

  return (
    <View
      testID='requests-indexer-notice'
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space["3"],
        padding: 12,
        marginBottom: 12,
        borderRadius: radius.lg,
        backgroundColor: color.bg["1"],
      }}
    >
      <Icon name='warning' tone='accent' size={18} />
      <View style={{ flex: 1 }}>
        <Text variant='body' weight='semibold'>
          {problem === "none-configured"
            ? t("requests.indexers_none_title")
            : t("requests.indexers_failing_title")}
        </Text>
        <Text variant='caption' tone='secondary' style={{ marginTop: 2 }}>
          {problem === "none-configured"
            ? t("requests.indexers_none_detail")
            : t("requests.indexers_failing_detail")}
        </Text>
      </View>
      <Button
        variant='secondary'
        size='sm'
        onPress={() => router.push("/settings/services")}
      >
        {t("home.settings.nav.services")}
      </Button>
    </View>
  );
}
