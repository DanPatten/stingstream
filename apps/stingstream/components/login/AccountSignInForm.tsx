import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, Platform, View } from "react-native";
import { Button } from "@/components/Button";
import { FormError } from "@/components/common/FormError";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import type { AccountServer } from "@/lib/stingstream/accountsApi";
import { serverOrigin } from "@/lib/stingstream/accountsApi";

/**
 * Signing in with a StingStream account, which is the point of having one.
 *
 * The screen this replaces asked "which server is yours?" and could not do anything else, because
 * nothing knew who you were. Dan, looking at it: *"why is it asking me for a server, that should be
 * optional and not required, first step is to ask the user to login or create an account."*
 *
 * So: a username, a password, and then your servers appear. The address form is still there, one
 * tap away, for somebody self-hosting an account service or reaching a machine the service has
 * never heard of — but it is no longer the first question anybody is asked.
 */
export interface AccountSignInFormProps {
  /** Throws with a ready-to-show sentence when the credentials are refused. */
  onSubmit: (username: string, password: string) => Promise<void>;
  /**
   * The servers this account can reach, once it has signed in. Null before then.
   *
   * Both the ones it owns and the ones sharing with it, because from the person's point of view
   * there is no difference: they are where their library comes from.
   */
  servers: AccountServer[] | null;
  onPickServer: (server: AccountServer) => void;
  /** Falls back to typing an address. Never the first thing offered. */
  onUseServerAddress: () => void;
  /** Shown while a server is being opened, so the list does not look inert. */
  busyNode?: string | null;
}

export const AccountSignInForm: React.FC<AccountSignInFormProps> = ({
  onSubmit,
  servers,
  onPickServer,
  onUseServerAddress,
  busyNode,
}) => {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = username.trim().length > 0 && password.length > 0;

  const submit = useCallback(async () => {
    if (!ready || busy) return;
    Keyboard.dismiss();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(username.trim(), password);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [busy, onSubmit, password, ready, username]);

  // Signed in: the question is no longer "who are you" but "which of these".
  if (servers) {
    return (
      <View>
        <Text variant='title' weight='semibold'>
          {t("account.pick_server_title")}
        </Text>
        <Text
          variant='caption'
          tone='secondary'
          style={{ marginTop: 4, marginBottom: 16 }}
        >
          {t("account.pick_server_detail")}
        </Text>

        {servers.length === 0 ? (
          <Text variant='caption' tone='secondary'>
            {t("account.no_servers")}
          </Text>
        ) : (
          <ListGroup>
            {servers.map((server) => {
              const reachable = serverOrigin(server) !== null;
              return (
                <ListItem
                  key={server.node}
                  testID='account-server'
                  title={server.name || t("account.unnamed_server")}
                  // A server with no address is the common case, not a fault: most people have no
                  // domain. Saying so beats showing it as offline, which would send somebody
                  // looking at their network instead of at a setting.
                  subtitle={
                    reachable
                      ? server.owned
                        ? t("account.server_yours")
                        : t("account.server_shared")
                      : t("account.server_no_address")
                  }
                  disabled={!reachable || busyNode === server.node}
                  showArrow={reachable}
                  onPress={reachable ? () => onPickServer(server) : undefined}
                />
              );
            })}
          </ListGroup>
        )}

        <Button
          variant='ghost'
          size='sm'
          onPress={onUseServerAddress}
          style={{ alignSelf: "flex-start", marginTop: 12 }}
        >
          {t("account.use_server_address")}
        </Button>
      </View>
    );
  }

  return (
    <View>
      <Text variant='title' weight='semibold'>
        {t("account.sign_in_title")}
      </Text>
      <Text
        variant='caption'
        tone='secondary'
        style={{ marginTop: 4, marginBottom: 20 }}
      >
        {t("account.sign_in_detail")}
      </Text>

      <Input
        testID='account-username'
        placeholder={t("account.username_placeholder")}
        autoCapitalize='none'
        autoCorrect={false}
        autoComplete='username'
        value={username}
        editable={!busy}
        onChangeText={setUsername}
        returnKeyType='next'
      />
      <View style={{ height: 12 }} />
      <Input
        testID='account-password'
        placeholder={t("account.password_placeholder")}
        secureTextEntry
        autoCapitalize='none'
        autoCorrect={false}
        autoComplete='current-password'
        value={password}
        editable={!busy}
        onChangeText={setPassword}
        returnKeyType='done'
        onSubmitEditing={() => void submit()}
      />

      <FormError message={error} />

      <View style={{ height: 20 }} />

      <Button
        testID='account-submit'
        onPress={() => void submit()}
        disabled={!ready}
        loading={busy}
        hasTVPreferredFocus={Platform.isTV && ready}
      >
        {t("account.sign_in_submit")}
      </Button>

      {/* Where an account comes from, said plainly. There is no sign-up form here and there is not
          going to be one: an account is created on a server you own, which is what keeps the
          service closed. Somebody with no server needs an invite from somebody who has one, and
          being told that beats hunting for a "register" link that does not exist. */}
      <Text
        variant='caption'
        tone='tertiary'
        style={{ marginTop: 16, textAlign: "center" }}
      >
        {t("account.no_account_hint")}
      </Text>

      <Button
        variant='ghost'
        size='sm'
        onPress={onUseServerAddress}
        testID='account-use-address'
        style={{ alignSelf: "center", marginTop: 8 }}
      >
        {t("account.use_server_address")}
      </Button>
    </View>
  );
};
