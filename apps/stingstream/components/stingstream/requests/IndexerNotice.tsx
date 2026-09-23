import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Button } from "@/components/Button";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { radius, space } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useTheme } from "@/hooks/useTheme";
import {
  indexerProblem,
  useIndexerHealth,
} from "@/lib/stingstream/indexerHealth";
import { useCanApproveRequests } from "@/lib/stingstream/requests";

/**
 * "The indexers have stopped answering."
 *
 * Search on this screen answers from TMDB, so it fills with results on a node that cannot fetch a
 * single one of them. When every configured indexer is failing, a request is accepted, searched for
 * nowhere, and never arrives; the only symptom is silence, days later, on a screen that said nothing
 * was wrong. That is a thing that used to work and has broken, and it is worth a line above the tabs.
 *
 * **A node with no indexer at all is deliberately not flagged here.** It used to be, as "No indexers
 * configured", and Dan asked for it gone from this page completely (2026-09-12). Not having set one
 * up is a choice the group can make on purpose: requests still collect on the list and wait, the
 * approvals queue becomes Wanted, and the place to change it is Settings → Indexers & engines.
 * `indexerProblem` still tells the cases apart, which is exactly what lets this draw only some.
 *
 * **Indexers with no download client is flagged**, as its own sentence. StingStream stopped running
 * a download client of its own on 2026-09-23, so a node can now search, find a release, and have
 * nowhere to send it. Unlike having no indexer that is never a choice: nothing waits usefully on
 * it, and every request made meanwhile is looked for and dropped.
 *
 * A banner above the tabs rather than a screen instead of them, which is what `RequestsNotSetUp`
 * does for its own case: searching, browsing and reading the queue all still work, and a request
 * made now starts working the moment the indexers answer again.
 *
 * Administrators only, and it does not ask the node anything for anybody else: the fix is two
 * screens away in settings, and a member told about indexers has been handed a word from our
 * plumbing and nothing to do with it.
 */
export function IndexerNotice() {
  const { color } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const { isCompact } = useBreakpoint();
  const isAdmin = useCanApproveRequests();
  const { data } = useIndexerHealth(isAdmin);

  const problem = indexerProblem(data);
  if (
    !isAdmin ||
    (problem !== "all-failing" && problem !== "no-download-client")
  ) {
    return null;
  }
  const noClient = problem === "no-download-client";

  // On a phone the button is a row of its own. Beside the text it claimed its
  // own width first and left the sentence a ten-character column down the
  // middle of the banner at 390 px.
  return (
    <View
      testID='requests-indexer-notice'
      style={{
        flexDirection: isCompact ? "column" : "row",
        alignItems: isCompact ? "flex-start" : "center",
        gap: space["3"],
        padding: 12,
        marginBottom: 12,
        borderRadius: radius.lg,
        backgroundColor: color.bg["1"],
      }}
    >
      <View style={{ flexDirection: "row", gap: space["3"], flex: 1 }}>
        <Icon name='warning' tone='accent' size={18} />
        <View style={{ flex: 1 }}>
          <Text variant='body' weight='semibold'>
            {noClient
              ? t("requests.no_download_client_title")
              : t("requests.indexers_failing_title")}
          </Text>
          <Text variant='caption' tone='secondary' style={{ marginTop: 2 }}>
            {noClient
              ? t("requests.no_download_client_detail")
              : t("requests.indexers_failing_detail")}
          </Text>
        </View>
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
