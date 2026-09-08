import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { FormError } from "@/components/common/FormError";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import {
  useNodeAccount,
  useRegisterNodeAccount,
  useResetNodeAccount,
} from "@/lib/stingstream/accounts";
import { FormCard } from "../mesh/FormCard";
import { Disclosure } from "../shared/Disclosure";
import { QueryState } from "../shared/ScreenState";

/**
 * Settings → Account: where a StingStream account comes from.
 *
 * **This is the only place one is created.** The account service has no sign-up page and is not
 * going to get one: registering is a request signed by this server's key, so the people who can
 * hold an account are exactly the people who installed StingStream. That is what keeps a service on
 * the public internet from being an open registration form.
 *
 * It is also the only way back into a forgotten account. With no email there is no reset link, so
 * proving you own an account means proving you control a machine it already owns — which is what
 * being an administrator here demonstrates.
 */
export function AccountScreen() {
  const { t } = useTranslation();
  const account = useNodeAccount();
  const register = useRegisterNodeAccount();
  const reset = useResetNodeAccount();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [claim, setClaim] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const claimed = !!account.data?.account;

  const submit = async () => {
    setError(null);
    try {
      const status = await register.mutateAsync({
        username: username.trim(),
        password,
        claim,
      });
      setUsername("");
      setPassword("");
      toast.success(
        t("account.created", { username: status.username ?? username }),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const submitReset = async () => {
    setError(null);
    try {
      await reset.mutateAsync(newPassword);
      setNewPassword("");
      toast.success(t("account.reset_done"));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <FormCard>
      <QueryState
        isLoading={account.isLoading}
        error={account.error}
        onRetry={account.refetch}
      >
        {claimed ? (
          <View>
            <Text variant='title' weight='semibold'>
              {t("account.mine_title", { username: account.data?.username })}
            </Text>
            <Text
              variant='caption'
              tone='secondary'
              style={{ marginTop: 4, marginBottom: 20 }}
            >
              {t("account.mine_detail")}
            </Text>

            <Disclosure title={t("account.reset_title")}>
              <Text
                variant='caption'
                tone='secondary'
                style={{ marginBottom: 12 }}
              >
                {t("account.reset_detail")}
              </Text>
              <Input
                testID='account-new-password'
                placeholder={t("account.password_placeholder")}
                secureTextEntry
                autoCapitalize='none'
                value={newPassword}
                editable={!reset.isPending}
                onChangeText={setNewPassword}
              />
              <FormError message={error} />
              <View style={{ height: 12 }} />
              <Button
                onPress={() => void submitReset()}
                disabled={newPassword.length < 8}
                loading={reset.isPending}
              >
                {t("account.reset_submit")}
              </Button>
            </Disclosure>
          </View>
        ) : (
          <View>
            <Text variant='title' weight='semibold'>
              {t("account.none_title")}
            </Text>
            <Text
              variant='caption'
              tone='secondary'
              style={{ marginTop: 4, marginBottom: 20 }}
            >
              {t("account.none_detail")}
            </Text>

            <Input
              testID='account-new-username'
              placeholder={t("account.username_placeholder")}
              autoCapitalize='none'
              autoCorrect={false}
              value={username}
              editable={!register.isPending}
              onChangeText={setUsername}
            />
            <View style={{ height: 12 }} />
            <Input
              testID='account-new-password'
              placeholder={t("account.password_placeholder")}
              secureTextEntry
              autoCapitalize='none'
              value={password}
              editable={!register.isPending}
              onChangeText={setPassword}
            />

            <FormError message={error} />

            <View style={{ height: 16 }} />

            <Button
              testID='account-create'
              onPress={() => void submit()}
              disabled={username.trim().length < 3 || password.length < 8}
              loading={register.isPending}
            >
              {claim ? t("account.claim_submit") : t("account.create_submit")}
            </Button>

            {/* Attaching a second machine is the same form with the same two fields, so it is a
                toggle rather than a second screen — and the password is required either way, which
                is what stops somebody attaching a machine they control to an account that is not
                theirs. */}
            <View style={{ marginTop: 16 }}>
              <ListGroup>
                <ListItem
                  testID='account-claim-toggle'
                  title={t("account.claim_title")}
                  subtitle={t("account.claim_detail")}
                  onPress={() => setClaim((v) => !v)}
                  iconAfter={
                    <Text
                      variant='caption'
                      tone={claim ? "accent" : "tertiary"}
                    >
                      {claim ? "✓" : ""}
                    </Text>
                  }
                />
              </ListGroup>
            </View>
          </View>
        )}

        {account.data?.service ? (
          <Text
            variant='caption'
            tone='tertiary'
            style={{ marginTop: 20, textAlign: "center" }}
          >
            {account.data.service}
          </Text>
        ) : null}
      </QueryState>
    </FormCard>
  );
}
