import { requireOptionalNativeModule } from "expo-modules-core";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import { toast } from "sonner-native";
import { Pill } from "@/components/common/Pill";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { space } from "@/constants/theme";
import { useNodeContext } from "@/hooks/useNodeContext";
import { useServerName } from "@/hooks/useServerName";
import { useMesh } from "@/providers/MeshProvider";

/**
 * Who this server is, at the top of the page about servers.
 *
 * It used to be at the *bottom*, inside an "Advanced" accordion, next to a heading that repeated
 * itself — and the page opened instead with an empty state announcing "No servers linked" over the
 * top of a request that was plainly waiting to be answered. Dan: *"the servers page has so much
 * fucking shit going on ... I cant make anything out"*.
 *
 * A page about linking servers has to start by saying which server you are looking at. Name,
 * whether it is reachable, and the address a link is built from — three lines, before anything
 * else on the screen.
 */
export const ThisServerCard: React.FC = () => {
  const { t } = useTranslation();
  const name = useServerName();
  const node = useNodeContext();
  const mesh = useMesh();

  // `addresses` is what the gateway will tell a stranger; `origin` is only ever
  // however *this* page arrived, which on the node's own machine is
  // `localhost` and means nothing to anybody else.
  const address = node?.addresses?.[0] ?? node?.origin ?? null;

  const copy = useCallback(async () => {
    if (!address) return;
    if (Platform.OS === "web") {
      try {
        await navigator.clipboard.writeText(address);
        toast.success(t("sharing.this_server_address_copied"));
      } catch {
        toast.error(t("sharing.this_server_address_copy_failed"));
      }
      return;
    }
    // Same probe `AboutSection` uses: a build without the native module returns
    // null rather than throwing, and a silent no-op is worse than a sentence.
    if (!requireOptionalNativeModule("ExpoClipboard")) {
      toast.error(t("sharing.this_server_address_copy_failed"));
      return;
    }
    const Clipboard = await import("expo-clipboard");
    await Clipboard.setStringAsync(address);
    toast.success(t("sharing.this_server_address_copied"));
  }, [address, t]);

  const reach = mesh.available
    ? mesh.running
      ? t("sharing.this_server_reach_direct")
      : t("sharing.this_server_reach_starting")
    : t("sharing.this_server_reach_via_server");

  return (
    <View testID='sharing-this-server'>
      <ListGroup title={t("sharing.this_server_title")}>
        <ListItem
          title={name ?? t("sharing.server_untitled")}
          subtitle={reach}
          iconAfter={
            <Pill
              icon='devices'
              tone={mesh.available && mesh.running ? "success" : "neutral"}
              size='sm'
              label={
                mesh.available && mesh.running
                  ? t("sharing.this_server_online")
                  : t("sharing.this_server_relayed")
              }
            />
          }
        />
        {address ? (
          <ListItem
            testID='sharing-this-server-address'
            title={t("sharing.this_server_address")}
            subtitle={address}
            icon='link'
            onPress={copy}
            iconAfter={
              <Text variant='caption' tone='secondary'>
                {t("sharing.this_server_address_copy")}
              </Text>
            }
          />
        ) : null}
      </ListGroup>
      <View style={{ height: space["1"] }} />
    </View>
  );
};
