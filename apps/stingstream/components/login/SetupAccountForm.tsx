import { Ionicons } from "@expo/vector-icons";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, Pressable, View } from "react-native";
import { Button } from "@/components/Button";
import { FormError } from "@/components/common/FormError";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { tokens } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import {
  isSetupFormValid,
  PASSWORD_MIN_LENGTH,
  type SetupFormErrors,
  validateSetupForm,
} from "@/lib/stingstream/setup";

export interface SetupAccountFormProps {
  /** Creates the account and signs in. Throws with a ready-to-show sentence when it cannot. */
  onSubmit: (username: string, password: string) => Promise<void>;
}

/**
 * First run, on the machine the node runs on: the one screen between installing StingStream and
 * using it.
 *
 * There is no skip and no wizard. Dan's instruction was "no setup step either with that Jellyfin
 * shit" — the account has to exist for anything to work, so this asks for it once, in StingStream's
 * own words, and then puts the user on Home. Everything else a first run used to ask (libraries,
 * metadata providers, remote access) the node already decided for itself.
 */
export const SetupAccountForm: React.FC<SetupAccountFormProps> = ({
  onSubmit,
}) => {
  const { t } = useTranslation();
  const { isCompact } = useBreakpoint();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /**
   * Validation appears once the field has been left, not on the first keystroke — telling somebody
   * their password is too short after they have typed one character is noise, not help.
   */
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const values = { username, password, confirm };
  const errors: SetupFormErrors = validateSetupForm(values);
  const showing = (field: keyof SetupFormErrors): string | null =>
    touched[field] ? (errors[field] ?? null) : null;

  const submit = useCallback(async () => {
    if (busy) return;
    Keyboard.dismiss();
    setTouched({ username: true, password: true, confirm: true });
    setFormError(null);
    if (!isSetupFormValid(validateSetupForm({ username, password, confirm }))) {
      return;
    }

    setBusy(true);
    try {
      await onSubmit(username.trim(), password);
    } catch (e) {
      setFormError(
        e instanceof Error && e.message
          ? e.message
          : t("setup.error_unexpected"),
      );
    } finally {
      setBusy(false);
    }
  }, [busy, username, password, confirm, onSubmit, t]);

  const revealToggle = (
    <Pressable
      onPress={() => setRevealed((v) => !v)}
      accessibilityRole='button'
      accessibilityLabel={
        revealed ? t("login.hide_password") : t("login.show_password")
      }
      hitSlop={8}
      style={{
        position: "absolute",
        right: 10,
        top: 0,
        height: tokens.control.minTouchTarget,
        width: 32,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Ionicons
        name={revealed ? "eye-off-outline" : "eye-outline"}
        size={18}
        color={tokens.color.text.tertiary}
      />
    </Pressable>
  );

  return (
    <View testID='firstrun-create-account'>
      <Text variant={isCompact ? "title" : "display"} weight='bold'>
        {t("setup.title")}
      </Text>
      <Text variant='body' tone='secondary' style={{ marginTop: 8 }}>
        {t("setup.description")}
      </Text>

      <View style={{ marginTop: 24, gap: 12 }}>
        <Input
          testID='firstrun-username'
          aria-label={t("setup.username")}
          placeholder={t("setup.username")}
          value={username}
          onChangeText={setUsername}
          onBlur={() => setTouched((s) => ({ ...s, username: true }))}
          error={showing("username")}
          autoCapitalize='none'
          autoCorrect={false}
          autoComplete='username-new'
          textContentType='username'
          returnKeyType='next'
          maxLength={64}
          editable={!busy}
        />
        <View>
          <Input
            testID='firstrun-password'
            aria-label={t("setup.password")}
            placeholder={t("setup.password")}
            value={password}
            onChangeText={setPassword}
            onBlur={() => setTouched((s) => ({ ...s, password: true }))}
            error={showing("password")}
            secureTextEntry={!revealed}
            autoCapitalize='none'
            autoComplete='new-password'
            textContentType='newPassword'
            returnKeyType='next'
            maxLength={500}
            editable={!busy}
            style={{ paddingRight: 44 }}
          />
          {revealToggle}
        </View>
        {showing("password") ? null : (
          <Text variant='caption' tone='tertiary' style={{ marginTop: -6 }}>
            {t("setup.password_hint", { min: PASSWORD_MIN_LENGTH })}
          </Text>
        )}
        <Input
          testID='firstrun-confirm'
          aria-label={t("setup.confirm_password")}
          placeholder={t("setup.confirm_password")}
          value={confirm}
          onChangeText={setConfirm}
          onBlur={() => setTouched((s) => ({ ...s, confirm: true }))}
          error={showing("confirm")}
          secureTextEntry={!revealed}
          autoCapitalize='none'
          autoComplete='new-password'
          textContentType='newPassword'
          returnKeyType='go'
          maxLength={500}
          editable={!busy}
          onSubmitEditing={submit}
        />
      </View>

      <FormError message={formError} style={{ marginTop: 12 }} />

      <Button
        testID='firstrun-submit'
        variant='primary'
        size='lg'
        onPress={submit}
        loading={busy}
        disabled={busy}
        style={{ marginTop: 20 }}
      >
        {t("setup.create_account")}
      </Button>
    </View>
  );
};
