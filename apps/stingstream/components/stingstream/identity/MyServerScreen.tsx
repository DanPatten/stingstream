import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Platform, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { radius, tokens } from "@/constants/theme";
import { useMyLinkRequest, useRequestLink } from "@/lib/stingstream/identity";
import { EmptyState, QueryState } from "../shared/ScreenState";

/**
 * "The server I run" — the one sharing screen a client keeps.
 *
 * Dan, when Servers moved behind the administrator gate: *"make sure that client users can still
 * decide to share their server that they own in settings or manage the connection or whats
 * shared"*. Everything on `/settings/servers` is about **this** server, which is why it is an
 * administrator's; this screen is about **theirs**, which is nobody else's business but their own.
 *
 * ## Why it hands you off rather than doing it here
 *
 * Choosing what your server shares is an administrator action **on your server**, and you are its
 * administrator. So once a link is approved this screen gives you the one thing you cannot get
 * anywhere else — the invite — and a button that opens it on your own server, where the existing
 * Join screen and the "each side picks its own" picker already do the job properly.
 *
 * The alternative was proxying every mesh call through a second session held here. That would mean
 * this app holding an administrator's token for another server in order to redraw screens that
 * already exist there, and every one of those screens would have to learn which server it was
 * talking about. A link is smaller and it is also more honest about whose decision it is.
 */
export const MyServerScreen: React.FC = () => {
  const { t } = useTranslation();
  const request = useMyLinkRequest();
  const ask = useRequestLink();
  const [address, setAddress] = useState("");

  const data = request.data;

  const copy = useCallback(
    async (value: string) => {
      if (Platform.OS === "web") {
        try {
          await navigator.clipboard.writeText(value);
          toast.success(t("identity.my_server_copied"));
        } catch {
          toast.error(t("invites.copy_failed"));
        }
        return;
      }
      const Clipboard = await import("expo-clipboard");
      await Clipboard.setStringAsync(value);
      toast.success(t("identity.my_server_copied"));
    },
    [t],
  );

  const openOnMyServer = useCallback(
    (code: string) => {
      const origin = address.trim().replace(/\/+$/, "");
      if (!origin) {
        void copy(code);
        return;
      }
      const url = `${/^https?:\/\//i.test(origin) ? origin : `https://${origin}`}/join#${code}`;
      void Linking.openURL(url);
    },
    [address, copy],
  );

  return (
    <QueryState
      isLoading={request.isPending}
      error={request.error}
      onRetry={() => void request.refetch()}
    >
      {/* An ordinary account, created here with a password. There is no other server in the
          picture, so there is nothing to say about one -- and inventing a "connect a server"
          form for somebody who does not run one is a screen that can only disappoint. */}
      {!data?.issuerNodeId ? (
        <EmptyState
          icon='sharing'
          title={t("identity.my_server_none_title")}
          detail={t("identity.my_server_none_detail")}
        />
      ) : (
        <View style={{ gap: 16 }}>
          <ListGroup title={t("identity.my_server_title")}>
            <ListItem
              title={t("identity.my_server_node")}
              subtitle={data.issuerNodeId}
            />
            <ListItem
              title={t("identity.my_server_status")}
              subtitle={
                data.status === "approved"
                  ? t("identity.my_server_status_approved", {
                      server: data.serverName,
                    })
                  : data.status === "pending"
                    ? t("identity.my_server_status_pending", {
                        server: data.serverName,
                      })
                    : data.status === "declined"
                      ? t("identity.my_server_status_declined", {
                          server: data.serverName,
                        })
                      : t("identity.my_server_status_none", {
                          server: data.serverName,
                        })
              }
            />
          </ListGroup>

          {/* Nothing asked yet, or asked and turned down. Asking again after a decline is allowed
              and does nothing until an administrator changes their mind -- the server keeps the
              decision, so a second ask cannot quietly reset it. */}
          {data.status !== "approved" && data.status !== "pending" ? (
            <View style={{ gap: 8 }}>
              <Text variant='caption' tone='secondary'>
                {t("identity.my_server_ask_detail", {
                  server: data.serverName,
                })}
              </Text>
              <Button
                testID='my-server-ask'
                variant='primary'
                size='lg'
                loading={ask.isPending}
                disabled={ask.isPending}
                onPress={() =>
                  ask.mutate(undefined, {
                    onError: (e) => toast.error(e.message),
                  })
                }
              >
                {t("identity.my_server_ask")}
              </Button>
            </View>
          ) : null}

          {data.status === "approved" && data.code ? (
            <View style={{ gap: 12 }}>
              <Text variant='caption' tone='secondary'>
                {t("identity.my_server_approved_detail", {
                  server: data.serverName,
                })}
              </Text>

              {/* Shown whole. An ellipsis in the middle of a credential is the one place somebody
                  cannot tell styling from content -- the same call the minted-invite dialog makes. */}
              <View
                style={{
                  borderRadius: radius.sm,
                  backgroundColor: tokens.color.bg["2"],
                  padding: 12,
                }}
              >
                <Text variant='caption' selectable testID='my-server-code'>
                  {data.code}
                </Text>
              </View>

              {/* Asked for here rather than remembered from the sign-in, because it is only
                  needed at this one moment and because it is not this server's business where
                  yours lives. Leave it blank and the button copies the code instead. */}
              <View>
                <Text variant='caption' tone='secondary' weight='medium'>
                  {t("identity.my_server_address")}
                </Text>
                <Text
                  variant='caption'
                  tone='tertiary'
                  style={{ marginBottom: 6 }}
                >
                  {t("identity.my_server_address_hint")}
                </Text>
                <Input
                  testID='my-server-address'
                  placeholder={t("identity.own_server_placeholder")}
                  value={address}
                  onChangeText={setAddress}
                  autoCapitalize='none'
                  autoCorrect={false}
                  autoComplete='off'
                  keyboardType='url'
                />
              </View>

              <Button
                testID='my-server-open'
                variant='primary'
                size='lg'
                icon='link'
                disabled={address.trim().length === 0}
                onPress={() => openOnMyServer(data.code as string)}
              >
                {t("identity.my_server_open")}
              </Button>
              <Button
                variant='secondary'
                icon='link'
                onPress={() => void copy(data.code as string)}
              >
                {t("identity.my_server_copy")}
              </Button>
            </View>
          ) : null}
        </View>
      )}
    </QueryState>
  );
};
