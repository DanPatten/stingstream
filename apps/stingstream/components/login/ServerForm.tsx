import { Ionicons } from "@expo/vector-icons";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, Platform, Pressable, View } from "react-native";
import { Button } from "@/components/Button";
import { FormError } from "@/components/common/FormError";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import JellyfinServerDiscovery from "@/components/JellyfinServerDiscovery";
import { PreviousServersList } from "@/components/PreviousServersList";
import { CustomHeaderSheet } from "@/components/settings/CustomHeaderSheet";
import { tokens } from "@/constants/theme";
import { useGlobalModal } from "@/providers/GlobalModalProvider";
import { type CustomHeader, usableCustomHeaders } from "@/utils/customHeaders";
import type { SavedServer } from "@/utils/secureCredentials";

export interface ServerFormProps {
  /** The address typed or picked. Throws with a ready-to-show sentence when it will not connect. */
  onConnect: (url: string, headers?: CustomHeader[]) => Promise<void>;
  /** A previously saved account, signed in without asking for the password again. */
  onQuickLogin?: (serverUrl: string, userId: string) => Promise<void>;
  onPasswordLogin?: (
    serverUrl: string,
    username: string,
    password: string,
  ) => Promise<void>;
  onAddAccount?: (server: SavedServer) => void;
  /** Shown when the app got here from a node — "back" is the sign-in card, not nothing. */
  onCancel?: () => void;
  initialUrl?: string;
}

/**
 * "Which server?", for the cases where the app genuinely cannot know: a phone, a television, a
 * bundle opened from a static host.
 *
 * On a node-served web build this is never the first screen. That flash of "Enter the URL to your
 * Jellyfin server" in front of somebody who just installed StingStream and opened localhost was
 * the first thing Dan saw and the first thing he asked to remove.
 */
export const ServerForm: React.FC<ServerFormProps> = ({
  onConnect,
  onQuickLogin,
  onPasswordLogin,
  onAddAccount,
  onCancel,
  initialUrl = "",
}) => {
  const { t } = useTranslation();
  const { showModal, hideModal } = useGlobalModal();

  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Headers entered before connecting. `undefined` keeps whatever is already saved for the
  // server (see checkJellyfinServer), so a half-filled row can never overwrite working ones.
  const [pendingHeaders, setPendingHeaders] = useState<CustomHeader[]>([]);
  const usableHeaders = usableCustomHeaders(pendingHeaders);
  const connectHeaders = usableHeaders.length > 0 ? usableHeaders : undefined;

  const connect = useCallback(
    async (address: string, headers?: CustomHeader[]) => {
      if (busy || address.trim().length === 0) return;
      Keyboard.dismiss();
      setError(null);
      setBusy(true);
      try {
        await onConnect(address, headers);
      } catch (e) {
        setError(
          e instanceof Error && e.message
            ? e.message
            : t("login.could_not_connect_to_server"),
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, onConnect, t],
  );

  const openHeaderSheet = useCallback(() => {
    showModal(
      <CustomHeaderSheet
        initialHeaders={pendingHeaders}
        onChange={setPendingHeaders}
        onClose={hideModal}
      />,
    );
  }, [pendingHeaders, showModal, hideModal]);

  return (
    <View>
      <Text variant='title' weight='bold'>
        {t("login.connect_to_server")}
      </Text>
      <Text variant='body' tone='secondary' style={{ marginTop: 8 }}>
        {t("server.enter_url_to_jellyfin_server")}
      </Text>

      <View style={{ marginTop: 20 }}>
        <Input
          testID='login-server-url'
          aria-label={t("server.server_url")}
          placeholder={t("server.server_url_placeholder")}
          value={url}
          onChangeText={setUrl}
          keyboardType='url'
          autoCapitalize='none'
          autoCorrect={false}
          textContentType='URL'
          returnKeyType='go'
          maxLength={500}
          editable={!busy}
          onSubmitEditing={() => connect(url, connectHeaders)}
        />
      </View>

      <FormError message={error} style={{ marginTop: 8 }} />

      <Button
        testID='login-connect'
        variant='primary'
        size='lg'
        onPress={() => connect(url, connectHeaders)}
        loading={busy}
        disabled={busy || url.trim().length === 0}
        style={{ marginTop: 16 }}
      >
        {t("server.connect_button")}
      </Button>

      {onCancel ? (
        <Pressable
          onPress={onCancel}
          accessibilityRole='button'
          style={{ paddingVertical: 12, alignSelf: "center" }}
        >
          <Text variant='caption' tone='accent'>
            {t("common.cancel")}
          </Text>
        </Pressable>
      ) : null}

      {/* Discovery broadcasts on the LAN, which a browser cannot do at all — the button would be
          a control that never finds anything. */}
      {Platform.OS !== "web" ? (
        <View style={{ marginTop: 8 }}>
          <JellyfinServerDiscovery
            onServerSelect={async (server) => {
              setUrl(server.address);
              // A discovered server connects with its own saved headers; passing the ones typed
              // for a different address would overwrite them.
              await connect(server.address);
            }}
          />
        </View>
      ) : null}

      <PreviousServersList
        onServerSelect={async (s) => {
          await connect(s.address);
        }}
        onQuickLogin={onQuickLogin}
        onPasswordLogin={onPasswordLogin}
        onAddAccount={onAddAccount}
      />

      {/* Servers behind an access gateway need their headers before the very first request, so
          they are configured here — but they are a rarity, and a login screen that opens with a
          row about proxy headers is a login screen for administrators. */}
      <View style={{ marginTop: 12 }}>
        <Pressable
          onPress={() => setShowAdvanced((v) => !v)}
          accessibilityRole='button'
          accessibilityState={{ expanded: showAdvanced }}
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            paddingVertical: 8,
          }}
        >
          <Text variant='caption' tone='tertiary'>
            {t("login.advanced")}
          </Text>
          <Ionicons
            name={showAdvanced ? "chevron-up" : "chevron-down"}
            size={14}
            color={tokens.color.text.tertiary}
            style={{ marginLeft: 4 }}
          />
        </Pressable>
        {showAdvanced ? (
          <Pressable
            onPress={openHeaderSheet}
            accessibilityRole='button'
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingVertical: 12,
            }}
          >
            <Text variant='body' tone='accent'>
              {t("custom_headers.title")}
            </Text>
            <Text variant='caption' tone='tertiary'>
              {usableHeaders.length > 0
                ? t("custom_headers.header_count", {
                    count: usableHeaders.length,
                  })
                : t("custom_headers.source_none")}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
};
