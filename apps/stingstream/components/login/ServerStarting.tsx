import { useTranslation } from "react-i18next";
import { ActivityIndicator, View } from "react-native";
import { Button } from "@/components/Button";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { radius } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";

export interface ServerStartingProps {
  /** The node's own name, from the marker. Null until it is known. */
  serverName: string | null;
  /**
   * The node's LAN address(es) (`NodeContext.addresses`), shown only once waiting has stopped
   * working. Somebody on the machine itself does not need them; somebody looking at a headless
   * box that never came up does.
   */
  addresses: string[];
  /** True once the retry budget is spent and nothing more is happening on its own. */
  exhausted: boolean;
  /**
   * True when this is no longer *your* server coming up but a linked one being tried instead.
   *
   * Said out loud rather than done quietly: on web this ends in a navigation to a different domain
   * and a fresh sign-in, and a redirect nobody was warned about reads as something going wrong.
   */
  routing?: boolean;
  onRetry: () => void;
}

/**
 * "Your server is still starting."
 *
 * A node's gateway serves this page seconds — sometimes a minute, with the download managers
 * enabled — before the Jellyfin behind it is routable, and until it is, every request through it
 * comes back `503` (`gateway/mod.rs`). This card is what that moment looks like.
 *
 * It exists because of what used to happen instead. The old screen gave the connection ~1.4 s,
 * read the 503 as "that is not a StingStream server", and fell through to the address form — on a
 * page the node itself had just served. The right answer was never a question; it was a wait.
 */
export const ServerStarting: React.FC<ServerStartingProps> = ({
  serverName,
  addresses,
  exhausted,
  routing = false,
  onRetry,
}) => {
  const { t } = useTranslation();
  const { color, accent } = useTheme();

  return (
    <View testID='login-server-starting' style={{ alignItems: "center" }}>
      {exhausted ? (
        <Icon name='refresh' size={28} tone='secondary' />
      ) : (
        <ActivityIndicator size='small' color={accent[500]} />
      )}

      <Text
        variant='heading'
        weight='bold'
        align='center'
        style={{ marginTop: 16 }}
      >
        {exhausted
          ? t("login.starting_stalled_title")
          : routing
            ? t("login.routing_title", { server: serverName ?? "" })
            : serverName
              ? t("login.starting_title_named", { server: serverName })
              : t("login.starting_title")}
      </Text>

      <Text
        variant='body'
        tone='secondary'
        align='center'
        style={{ marginTop: 8 }}
      >
        {exhausted
          ? t("login.starting_stalled_description")
          : t(
              routing
                ? "login.routing_description"
                : "login.starting_description",
            )}
      </Text>

      {exhausted && addresses.length > 0 ? (
        <View style={{ marginTop: 20, gap: 8, alignSelf: "stretch" }}>
          {addresses.map((address) => (
            <View
              key={address}
              style={{
                paddingVertical: 14,
                paddingHorizontal: 16,
                borderRadius: radius.md,
                backgroundColor: color.bg["2"],
                borderWidth: 1,
                borderColor: color.border.subtle,
              }}
            >
              <Text variant='body' tone='accent' weight='medium' selectable>
                {address}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {exhausted ? (
        <Button
          variant='secondary'
          size='lg'
          icon='refresh'
          onPress={onRetry}
          style={{ marginTop: 20, alignSelf: "stretch" }}
        >
          {t("login.starting_retry")}
        </Button>
      ) : null}
    </View>
  );
};
