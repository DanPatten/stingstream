import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { FormError } from "@/components/common/FormError";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { useNodeAccount } from "@/lib/stingstream/accounts";
import {
  type AccountMe,
  type AccountServer,
  DEFAULT_ACCOUNT_SERVICE,
  fetchMe,
  setShare,
} from "@/lib/stingstream/accountsApi";
import { takeAccountSession } from "@/utils/accounts/session";
import { EmptyState } from "../shared/ScreenState";

/**
 * Sharing with a person, which is the thing Dan actually wanted.
 *
 * *"you register - you login, you share and you see it all as shared with you."* So the unit is a
 * person, named by their username — with no email anywhere, `@alice` is the only way to name
 * somebody — and the two lists are the two directions: what you have given, and what you have been
 * given.
 *
 * Underneath, a share is still the mesh doing what it always did. Two servers that share both ways
 * pool their libraries and skip a download the other already has, exactly as a group does; the
 * machinery stays and the word "group" leaves the screen.
 */
export function SharePeopleScreen() {
  const { t } = useTranslation();
  const account = useNodeAccount();

  const [me, setMe] = useState<AccountMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const token = takeAccountSession();
  const service = account.data?.service ?? DEFAULT_ACCOUNT_SERVICE;
  const myNode = account.data?.node ?? "";

  const refresh = useCallback(async () => {
    if (!token) {
      setLoading(false);
      return;
    }
    try {
      setMe(await fetchMe(service, token));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [service, token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const share = async (action: "share" | "revoke", who: string) => {
    if (!token) return;
    setError(null);
    setBusy(true);
    try {
      await setShare(service, token, { node: myNode, username: who }, action);
      setUsername("");
      await refresh();
      toast.success(
        action === "share"
          ? t("share.shared_with", { username: who })
          : t("share.stopped_with", { username: who }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Signing in here is what produced the token, so its absence means the person reached this screen
  // with a Jellyfin session but no account one — a local password sign-in. Saying so beats an empty
  // list, which would read as "nobody has shared with you".
  if (!token) {
    return (
      <EmptyState
        icon='sharing'
        title={t("share.needs_account_title")}
        detail={t("share.needs_account_detail")}
      />
    );
  }

  const sharedWithMe = (me?.servers ?? []).filter((s) => !s.owned);

  return (
    <View>
      <Text variant='heading' weight='semibold'>
        {t("share.give_title")}
      </Text>
      <Text
        variant='caption'
        tone='secondary'
        style={{ marginTop: 4, marginBottom: 12 }}
      >
        {t("share.give_detail")}
      </Text>

      <Input
        testID='share-username'
        placeholder={t("share.username_placeholder")}
        autoCapitalize='none'
        autoCorrect={false}
        value={username}
        editable={!busy}
        onChangeText={setUsername}
        returnKeyType='done'
        onSubmitEditing={() => void share("share", username.trim())}
      />
      <FormError message={error} />
      <View style={{ height: 12 }} />
      <Button
        testID='share-submit'
        onPress={() => void share("share", username.trim())}
        disabled={username.trim().length < 3}
        loading={busy}
      >
        {t("share.give_submit")}
      </Button>

      <View style={{ height: 28 }} />

      <Text variant='heading' weight='semibold'>
        {t("share.received_title")}
      </Text>
      <Text
        variant='caption'
        tone='secondary'
        style={{ marginTop: 4, marginBottom: 12 }}
      >
        {t("share.received_detail")}
      </Text>

      {loading ? null : sharedWithMe.length === 0 ? (
        <Text variant='caption' tone='secondary'>
          {t("share.received_empty")}
        </Text>
      ) : (
        <ListGroup>
          {sharedWithMe.map((server: AccountServer) => (
            <ListItem
              key={server.node}
              testID='share-received'
              title={server.name || t("account.unnamed_server")}
              subtitle={
                server.libraries && server.libraries.length > 0
                  ? t("share.libraries", {
                      libraries: server.libraries.join(", "),
                    })
                  : t("share.all_libraries")
              }
            />
          ))}
        </ListGroup>
      )}
    </View>
  );
}
