import { requireOptionalNativeModule } from "expo-modules-core";
import { useAtom } from "jotai";
import type React from "react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Platform, View } from "react-native";
import { toast } from "sonner-native";
import { Pill } from "@/components/common/Pill";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { BRAND } from "@/constants/brand";
import useRouter from "@/hooks/useAppRouter";
import { useNodeContext } from "@/hooks/useNodeContext";
import { apiAtom } from "@/providers/JellyfinProvider";
import { appVersionLabel } from "./ProfileHeader";

/**
 * `http://host:port/jellyfin` -> `http://host:port` — the address a person would actually type
 * into a browser, not Jellyfin's own mount point under the gateway. Falls back to the default
 * `/jellyfin` suffix off the native build, where there is no node marker to read the real one from.
 */
const stripJellyfinPath = (basePath: string, jellyfinPath: string): string => {
  const trimmedBase = basePath.replace(/\/+$/, "");
  const suffix = jellyfinPath.replace(/\/+$/, "");
  if (suffix && trimmedBase.toLowerCase().endsWith(suffix.toLowerCase())) {
    return (
      trimmedBase.slice(0, trimmedBase.length - suffix.length) || trimmedBase
    );
  }
  return trimmedBase;
};

/**
 * Version, server address, the access token behind a tap, a way back into the intro tour, and the
 * licences link — the honest, non-diagnostic-dump replacement for the old `UserInfo` table (F-30).
 *
 * The token is never on screen by default: `tokenVisible` gates it behind "Show", and even then it
 * is drawn from `api.accessToken` fresh on every render rather than cached anywhere new.
 */
export const AboutSection: React.FC = () => {
  const { t } = useTranslation();
  const router = useRouter();
  const [api] = useAtom(apiAtom);
  const nodeContext = useNodeContext();
  const [tokenVisible, setTokenVisible] = useState(false);

  const serverAddress = api?.basePath
    ? stripJellyfinPath(api.basePath, nodeContext?.jellyfinPath ?? "/jellyfin")
    : "";

  const copyToken = useCallback(async () => {
    const token = api?.accessToken;
    if (!token) return;
    if (Platform.OS === "web") {
      try {
        await navigator.clipboard.writeText(token);
        toast.success(t("home.settings.about.copied"));
      } catch {
        toast.error(t("home.settings.about.copy_failed"));
      }
      return;
    }
    // Builds without the expo-clipboard native module: probe first, as the rest of the app does
    // (components/settings/LinkDevice.tsx).
    if (!requireOptionalNativeModule("ExpoClipboard")) {
      toast.error(t("home.settings.about.copy_failed"));
      return;
    }
    const Clipboard = await import("expo-clipboard");
    await Clipboard.setStringAsync(token);
    toast.success(t("home.settings.about.copied"));
  }, [api?.accessToken, t]);

  return (
    <ListGroup title={t("home.settings.about.title")}>
      <ListItem
        title={t("home.settings.user_info.app_version")}
        value={appVersionLabel()}
      />
      <ListItem
        title={t("home.settings.about.server_address")}
        value={serverAddress}
      />
      {tokenVisible ? (
        <ListItem
          title={t("home.settings.user_info.token")}
          value={api?.accessToken ?? ""}
        />
      ) : (
        <ListItem
          testID='settings-token-show'
          title={t("home.settings.user_info.token")}
          onPress={() => setTokenVisible(true)}
        >
          <Pill label={t("home.settings.about.show")} tone='neutral' />
        </ListItem>
      )}
      {/* A sibling row, not `iconAfter` on the item above: `ListItem`'s own wrapper is a flex row,
          so anything passed as `iconAfter` competes for space with the token's `value` column
          (which takes `flex: 1` to wrap the token in full) rather than sitting below it — confirmed
          live, the buttons rendered with zero width and were reachable only by a screen reader. */}
      {tokenVisible && (
        <View
          style={{
            flexDirection: "row",
            justifyContent: "flex-end",
            gap: 8,
            paddingHorizontal: 16,
            paddingBottom: 10,
          }}
        >
          <Pill
            label={t("home.settings.about.hide")}
            tone='neutral'
            onPress={() => setTokenVisible(false)}
          />
          <Pill
            label={t("home.settings.about.copy")}
            tone='neutral'
            onPress={copyToken}
          />
        </View>
      )}
      <ListItem
        onPress={() => router.push("/settings/intro/page")}
        showArrow
        title={t("home.settings.about.take_the_tour")}
      />
      <ListItem
        onPress={() => Linking.openURL(`${BRAND.url}/blob/master/LICENSE.txt`)}
        showArrow
        title={t("home.settings.about.licences")}
      />
    </ListGroup>
  );
};
