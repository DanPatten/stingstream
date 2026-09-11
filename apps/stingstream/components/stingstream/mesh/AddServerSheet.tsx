import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
import { FormError } from "@/components/common/FormError";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { useNodeContext } from "@/hooks/useNodeContext";
import { useServerName } from "@/hooks/useServerName";
import { requestChallenge } from "@/lib/stingstream/identityApi";
import {
  buildAuthorizeUrl,
  returnTargetFromLocation,
} from "@/utils/identity/handoff";
import { resolveServerOrigin } from "@/utils/identity/resolveServer";

/**
 * The query parameter that carries the other server's address home again.
 *
 * The page that asks the question is replaced by a navigation to another origin, so nothing it was
 * holding survives to the answer. The assertion and the invite already ride back in the fragment
 * for that reason; this one rides in the query string instead, because it is an address rather
 * than a credential and the page it lands on has to be able to read it after a reload.
 */
export const LINK_TO_PARAM = "link_to";

/**
 * Add another server: type its address, prove you run it, come back with a link that finishes it.
 *
 * ## Why it starts with an address
 *
 * Dan: *"if you are already on a server you may either own a 2nd server or you are an end user who
 * has their own server. In this case clicking Add Server starts the same workflow as invite: Start
 * by asking for that other server's address and complete the wizard, same as invite."*
 *
 * Until now a link could only begin on the *other* server: you invited the person who ran it, they
 * signed in here with it, and the ask arrived. That is right for somebody you are introducing to
 * the product and useless for the two people this is for, neither of whom has anybody to invite.
 *
 * ## Why the browser leaves
 *
 * The same reason `SignInWithOwnServer` sends it away, and this is deliberately the same journey:
 * the alternative is posting a password across origins, which means the other server accepting
 * credentialed cross-origin requests from anywhere and somebody typing their password into a page
 * a different machine served. Going there keeps the password on its own origin.
 *
 * What comes back is an assertion signed by that server's node key, which is the only thing that
 * proves which node is being offered. A node id somebody typed would be a node id somebody chose.
 *
 * ## What this deliberately does not do
 *
 * It does not pick libraries. Nothing is shared until somebody says so, and *what this server
 * shares* is an administrator's decision about their own disk — so the picker belongs on the
 * completion panel, after the link exists, not in front of a member who cannot answer it.
 */
export const AddServerSheet: React.FC<{
  visible: boolean;
  onClose: () => void;
}> = ({ visible, onClose }) => {
  const { t } = useTranslation();
  const node = useNodeContext();
  const serverName = useServerName();
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    const typed = address.trim();
    if (!typed || busy) return;
    if (!node?.origin) {
      setError(t("identity.own_server_failed"));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      // The challenge first. If this server cannot start one there is no point sending anybody
      // anywhere, and the error belongs on the screen they are still looking at.
      const challenge = await requestChallenge(node.origin);

      const found = await resolveServerOrigin(typed);
      if (!found) {
        setError(t("identity.own_server_not_found"));
        return;
      }

      const here = returnTargetFromLocation() ?? node.origin;
      const separator = here.includes("?") ? "&" : "?";
      const returnTo = `${here}${separator}${LINK_TO_PARAM}=${encodeURIComponent(found)}`;

      const url = buildAuthorizeUrl(found, {
        audience: challenge.audience,
        nonce: challenge.nonce,
        returnTo,
        serverName: serverName ?? challenge.serverName,
        // The answer comes back beside the assertion and is what tells this page the return leg
        // is about adding a server rather than signing somebody in.
        link: true,
      });

      if (!url) {
        setError(t("identity.own_server_not_found"));
        return;
      }

      if (Platform.OS === "web") {
        // A full navigation, not a router push: the destination is a different origin, and the
        // router only knows about this one.
        (
          globalThis as { location?: { assign?: (u: string) => void } }
        ).location?.assign?.(url);
        return;
      }

      // On a phone the app is not a page, so there is no origin to come back to. The browser
      // sheet hands the redirect back to us instead.
      const WebBrowser = await import("expo-web-browser");
      await WebBrowser.openBrowserAsync(url);
      onClose();
    } catch (e) {
      setError((e as Error)?.message ?? t("identity.own_server_failed"));
    } finally {
      setBusy(false);
    }
  }, [address, busy, node?.origin, onClose, serverName, t]);

  return (
    <Dialog
      visible={visible}
      onClose={onClose}
      title={t("sharing.add_server_title")}
      description={t("sharing.add_server_detail")}
    >
      <View style={{ gap: 12 }}>
        <Input
          testID='sharing-add-server-address'
          placeholder={t("identity.own_server_placeholder")}
          value={address}
          onChangeText={setAddress}
          autoCapitalize='none'
          autoCorrect={false}
          autoComplete='off'
          keyboardType='url'
          returnKeyType='go'
          editable={!busy}
          onSubmitEditing={() => void start()}
        />

        <FormError message={error} />

        <Text variant='caption' tone='tertiary'>
          {t("sharing.add_server_hint")}
        </Text>

        <Button
          testID='sharing-add-server-continue'
          variant='primary'
          size='lg'
          loading={busy}
          disabled={busy || address.trim().length === 0}
          onPress={() => void start()}
        >
          {t("sharing.add_server_continue")}
        </Button>
      </View>
    </Dialog>
  );
};
