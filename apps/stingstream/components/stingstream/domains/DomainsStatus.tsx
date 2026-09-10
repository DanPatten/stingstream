import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Text } from "@/components/common/Text";
import { space, tokens } from "@/constants/theme";
import type { MeshDomainsStatus } from "@/lib/stingstream/meshApi";
import { domainsSummary } from "@/utils/mesh/domainsStatus";

/**
 * The address, and nothing else.
 *
 * This started as six titled states with a sentence each, became a `THIS NETWORK ONLY` label over
 * the address with one line under it, and is now the address on its own — Dan struck out both the
 * label and the line. He is right, and it is worth writing down why so it does not creep back:
 *
 * - **The label said what the address already says.** `http://192.168.0.16:8797` is visibly a
 *   private address, and `https://media.example.com` is visibly not. Naming the category above a
 *   value that states its own category is the kind of caption that reads as filler.
 * - **The explanatory line was about the product, not this server.** "The app reaches this server
 *   from anywhere. A browser needs to be on your network" is true of every node with no domain,
 *   which makes it documentation, and it sat in the one place somebody is looking for a fact about
 *   *their* server.
 *
 * What survives is the two moments when the address alone is not the whole truth: a tunnel coming
 * up, and one that failed. Both are transient, both are the result of something the reader just
 * did, and neither is a caption.
 */
export function DomainsStatus({
  status,
}: {
  status: MeshDomainsStatus | undefined;
}) {
  const { t } = useTranslation();
  const summary = domainsSummary(status);

  const note =
    summary.reach === "error"
      ? // The node's own words, which is what somebody can act on: "Invalid access token" sends
        // them to their token, and a scope error names the scope.
        (summary.detail ?? t("domains.reach_error"))
      : summary.reach === "starting"
        ? t("domains.reach_starting")
        : null;

  return (
    <View style={{ padding: 16, gap: space["2"] }}>
      {/* Selectable, because the first thing anybody does with an address is copy it. */}
      {summary.address ? (
        <Text variant='body' weight='semibold' selectable>
          {summary.address}
        </Text>
      ) : null}

      {note ? (
        <Text
          variant='caption'
          selectable
          tone={summary.reach === "error" ? "primary" : "tertiary"}
          style={
            summary.reach === "error"
              ? { color: tokens.color.state.danger }
              : undefined
          }
        >
          {note}
        </Text>
      ) : null}
    </View>
  );
}
