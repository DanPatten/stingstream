import { Ionicons } from "@expo/vector-icons";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, View } from "react-native";
import { Button } from "@/components/Button";
import { FormError } from "@/components/common/FormError";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { tokens } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useTheme } from "@/hooks/useTheme";
import {
  isSetupFormValid,
  PASSWORD_MIN_LENGTH,
  type SetupFormErrors,
  validateSetupForm,
} from "@/lib/stingstream/setup";
import { FocusPressable } from "./FocusPressable";

/**
 * What a server is called before anybody says otherwise.
 *
 * `config.toml`'s `node_name` is the machine's own, or whatever a container was told, and it leaked
 * into the places a person actually reads: *"You have been invited to ui-loop"*. So setup asks, and
 * this is the answer for anybody who does not care.
 */
export const DEFAULT_SERVER_NAME = "StingStream";

export interface SetupAccountFormProps {
  /** Creates the account and signs in. Throws with a ready-to-show sentence when it cannot. */
  onSubmit: (
    username: string,
    password: string,
    serverName: string,
  ) => Promise<void>;
}

/**
 * First run, second page: the account that owns this server.
 *
 * There is no skip and no wizard. Dan's instruction was "no setup step either with that Jellyfin
 * shit" — the account has to exist for anything to work, so this asks for it once, in StingStream's
 * own words, and then puts the user on Home. Everything else a first run used to ask (libraries,
 * metadata providers, remote access) the node already decided for itself.
 *
 * **It says out loud that this is the administrator.** It used to be headed "Create your
 * StingStream account", which is true and incomplete: this is not *an* account on the server, it
 * is the one that runs it — it manages libraries, invites everybody else, and is what somebody is
 * signing in as when they later wonder why they can see settings their sister cannot. Naming that
 * here costs one line and saves the question.
 */
export const SetupAccountForm: React.FC<SetupAccountFormProps> = ({
  onSubmit,
}) => {
  const { color } = useTheme();
  const { t } = useTranslation();
  const { isCompact } = useBreakpoint();

  const [serverName, setServerName] = useState(DEFAULT_SERVER_NAME);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /**
   * Validation appears once the field has been left, not on the first keystroke — telling somebody
   * their password is too short after they have typed one character is noise, not help.
   */
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const values = { username, password };
  const errors: SetupFormErrors = validateSetupForm(values);
  const showing = (field: keyof SetupFormErrors): string | null =>
    touched[field] ? (errors[field] ?? null) : null;

  const submit = useCallback(async () => {
    if (busy) return;
    Keyboard.dismiss();
    setTouched({ username: true, password: true });
    setFormError(null);
    if (!isSetupFormValid(validateSetupForm({ username, password }))) {
      return;
    }

    setBusy(true);
    try {
      // Blank means "leave it alone" rather than "call it nothing": somebody who clears the field
      // gets the name the node already had, not an empty one.
      await onSubmit(username.trim(), password, serverName.trim());
    } catch (e) {
      setFormError(
        e instanceof Error && e.message
          ? e.message
          : t("setup.error_unexpected"),
      );
    } finally {
      setBusy(false);
    }
  }, [busy, username, password, serverName, onSubmit, t]);

  const revealToggle = (
    <FocusPressable
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
        color={color.text.tertiary}
      />
    </FocusPressable>
  );

  return (
    <View testID='firstrun-create-account'>
      {/* `title` (26–32 px) from 768 up: at `display` size this whole sentence wrapped to three
          lines even in the wider 460 px card, which read as a poster rather than as a form.
          `display` stays for the phone card, where it is the one headline on the screen. */}
      <Text variant={isCompact ? "display" : "title"} weight='bold'>
        {t("setup.title")}
      </Text>
      <Text variant='body' tone='secondary' style={{ marginTop: 8 }}>
        {t("setup.description")}
      </Text>

      <View style={{ marginTop: 20, gap: 12 }}>
        <Text variant='caption' tone='secondary' weight='medium'>
          {t("setup.server_name")}
        </Text>
        <Input
          testID='firstrun-server-name'
          aria-label={t("setup.server_name")}
          placeholder={DEFAULT_SERVER_NAME}
          value={serverName}
          onChangeText={setServerName}
          autoCapitalize='words'
          autoCorrect={false}
          maxLength={64}
          editable={!busy}
          style={{ marginBottom: 4 }}
        />
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
            returnKeyType='go'
            maxLength={500}
            editable={!busy}
            onSubmitEditing={submit}
            style={{ paddingRight: 44 }}
          />
          {revealToggle}
        </View>
        {showing("password") ? null : (
          <Text variant='caption' tone='tertiary' style={{ marginTop: -6 }}>
            {t("setup.password_hint", { min: PASSWORD_MIN_LENGTH })}
          </Text>
        )}
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
