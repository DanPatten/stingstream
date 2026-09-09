import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Keyboard, Platform, View } from "react-native";
import { Button } from "@/components/Button";
import { FormError } from "@/components/common/FormError";
import { Icon } from "@/components/common/Icon";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { PreviousServersList } from "@/components/PreviousServersList";
import { useDiscoveredServers } from "@/hooks/useDiscoveredServers";
import { useTheme } from "@/hooks/useTheme";
import type { SavedServer } from "@/utils/secureCredentials";
import { typedAddressCandidates } from "@/utils/serverUrl/nodeCandidates";
import { FocusPressable } from "./FocusPressable";

export interface ConnectScreenProps {
  /** The address picked or typed. Throws with a ready-to-show sentence when it will not connect. */
  onConnect: (url: string) => Promise<void>;
  /** A previously saved account, signed in without asking for the password again. */
  onQuickLogin?: (serverUrl: string, userId: string) => Promise<void>;
  onPasswordLogin?: (
    serverUrl: string,
    username: string,
    password: string,
  ) => Promise<void>;
  onAddAccount?: (server: SavedServer) => void;
  initialUrl?: string;
}

/**
 * "Which server?", for the cases where the app genuinely cannot know: a phone, a television, a
 * bundle opened from something that is not a node.
 *
 * **It is never the first screen on a page a node served.** That is the whole of Part 6 in one
 * sentence — the origin is the server, and `decidePhase` will not route here with a node marker
 * present. This screen used to appear there anyway, on a cold node, offering to connect to the
 * address already in the URL bar.
 *
 * The order is Home Assistant's, and it is the opposite of what this file used to do. It led with
 * a text field and buried "search for local servers" under it as a button somebody had to know to
 * press. Now the network is searched the moment the screen opens, what it finds is offered, and
 * typing an address is the fallback for when that comes up empty — which is what it should be,
 * because almost nobody knows their server's address and almost everybody is on the same network
 * as it.
 */
export const ConnectScreen: React.FC<ConnectScreenProps> = ({
  onConnect,
  onQuickLogin,
  onPasswordLogin,
  onAddAccount,
  initialUrl = "",
}) => {
  const { t } = useTranslation();
  const { accent } = useTheme();

  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Typing is offered, not imposed: the field appears when somebody asks for it, or straight away
  // when they arrived with an address already in hand (a deep link).
  const [typing, setTyping] = useState(initialUrl.length > 0);

  // Discovery broadcasts on the LAN, which a browser cannot do at all.
  const discoverable = Platform.OS !== "web";
  const { servers: found, searching, search } = useDiscoveredServers();

  useEffect(() => {
    if (discoverable) search();
  }, [discoverable, search]);

  const connect = useCallback(
    async (address: string) => {
      if (busy || address.trim().length === 0) return;
      Keyboard.dismiss();
      setError(null);
      setBusy(true);
      try {
        await onConnect(address);
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

  /**
   * Connect to something somebody typed, forgiving the thing they are most likely to have left
   * out. `checkJellyfinServer` already handles a missing scheme and a missing `/jellyfin`; the
   * port is the third, and it is the one that fails looking like a wrong address.
   */
  const connectTyped = useCallback(async () => {
    if (busy) return;
    const candidates = typedAddressCandidates(url);
    if (candidates.length === 0) return;

    Keyboard.dismiss();
    setError(null);
    setBusy(true);
    try {
      let last: unknown;
      for (const candidate of candidates) {
        try {
          await onConnect(candidate);
          return;
        } catch (e) {
          last = e;
        }
      }
      // The first candidate's failure is the one worth reporting: it is the address they typed.
      setError(
        last instanceof Error && last.message
          ? last.message
          : t("login.could_not_connect_to_server"),
      );
    } finally {
      setBusy(false);
    }
  }, [busy, onConnect, t, url]);

  return (
    <View>
      <Text variant='title' weight='bold'>
        {t("login.find_server_title")}
      </Text>
      <Text variant='body' tone='secondary' style={{ marginTop: 8 }}>
        {t(
          discoverable
            ? "login.find_server_description"
            : "login.find_server_description_typed",
        )}
      </Text>

      {/* A server used before is the fastest way back to it, and it comes with its accounts —
          so it goes above a network search that would only find the same machine again. */}
      <PreviousServersList
        onServerSelect={async (s) => {
          await connect(s.address);
        }}
        onQuickLogin={onQuickLogin}
        onPasswordLogin={onPasswordLogin}
        onAddAccount={onAddAccount}
      />

      {discoverable ? (
        <View style={{ marginTop: 16 }}>
          {found.length > 0 ? (
            <ListGroup title={t("login.found_on_your_network")}>
              {found.map((server) => (
                <ListItem
                  key={server.url}
                  testID='login-discovered-server'
                  onPress={() => connect(server.url)}
                  title={server.name || server.url}
                  subtitle={server.name ? server.url : undefined}
                  showArrow
                />
              ))}
            </ListGroup>
          ) : (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingVertical: 12,
              }}
            >
              {searching ? (
                <ActivityIndicator size='small' color={accent[500]} />
              ) : (
                <Icon name='search' size={18} tone='tertiary' />
              )}
              <Text
                variant='caption'
                tone='tertiary'
                style={{ marginLeft: 10, flex: 1 }}
              >
                {t(
                  searching
                    ? "login.searching_network"
                    : "login.nothing_on_this_network",
                )}
              </Text>
              {searching ? null : (
                <FocusPressable
                  onPress={search}
                  accessibilityRole='button'
                  style={{ paddingVertical: 6, paddingHorizontal: 4 }}
                >
                  <Text variant='caption' tone='accent'>
                    {t("login.search_again")}
                  </Text>
                </FocusPressable>
              )}
            </View>
          )}
        </View>
      ) : null}

      {typing ? (
        <View style={{ marginTop: 16 }}>
          {/* An IP example, not `your-server.com`: this screen exists for a phone, and the address
              that works there is the one on the home network — "localhost only works on the same
              PC" (Dan, 2026-09-07). The port is optional now, so the hint does not insist on it. */}
          <Input
            testID='login-server-url'
            aria-label={t("server.server_url")}
            placeholder={t("login.server_address_hint")}
            value={url}
            onChangeText={setUrl}
            keyboardType='url'
            autoCapitalize='none'
            autoCorrect={false}
            autoFocus={initialUrl.length === 0}
            textContentType='URL'
            returnKeyType='go'
            maxLength={500}
            editable={!busy}
            onSubmitEditing={connectTyped}
          />

          <FormError message={error} style={{ marginTop: 8 }} />

          <Button
            testID='login-connect'
            variant='primary'
            size='lg'
            onPress={connectTyped}
            loading={busy}
            disabled={busy || url.trim().length === 0}
            style={{ marginTop: 16 }}
          >
            {t("server.connect_button")}
          </Button>
        </View>
      ) : (
        <>
          <FormError message={error} style={{ marginTop: 8 }} />
          <Button
            testID='login-enter-address'
            variant='secondary'
            size='lg'
            onPress={() => setTyping(true)}
            style={{ marginTop: 16 }}
          >
            {t("login.enter_address_instead")}
          </Button>
        </>
      )}
    </View>
  );
};
