import { Ionicons } from "@expo/vector-icons";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, Platform, Pressable, Switch, View } from "react-native";
import { Button } from "@/components/Button";
import { FormError } from "@/components/common/FormError";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { tokens } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useTheme } from "@/hooks/useTheme";

export interface SignInFormProps {
  /**
   * Whose server this is, as the node called itself. Never Jellyfin's `ServerName`, which on
   * Dan's machine was the Windows hostname — "Log in to PLEXPC" is the exact line that started
   * this rewrite.
   */
  serverName: string | null;
  /** Throws with a ready-to-show sentence when the credentials are refused. */
  onSubmit: (username: string, password: string) => Promise<void>;
  /**
   * Owned by the screen, not by this form: the code sign-in below has to honour the same choice,
   * and it completes after this component is gone.
   */
  keepSignedIn: boolean;
  onKeepSignedInChange: (value: boolean) => void;
  /** Shown as a "Sign in with a code" link. Phone only — never on desktop web. */
  onSignInWithCode?: () => void;
  /** Clears the connected server and goes back to the address form. */
  onUseDifferentServer?: () => void;
  /**
   * True when a node served this page. The address form is then an escape hatch behind
   * "Advanced", not a step: the server you want is the one you are already talking to.
   */
  servedByNode: boolean;
}

/**
 * The sign-in card.
 *
 * Every failure lands in a `FormError` under the form. The old screen reported all five of its
 * failure modes through `Alert.alert`, which draws *nothing at all* on react-native-web — a wrong
 * password in a browser did nothing whatsoever, with no message and no console line (bug 2).
 */
export const SignInForm: React.FC<SignInFormProps> = ({
  serverName,
  onSubmit,
  keepSignedIn,
  onKeepSignedInChange,
  onSignInWithCode,
  onUseDifferentServer,
  servedByNode,
}) => {
  const { t } = useTranslation();
  const { isWebWide, isCompact } = useBreakpoint();
  const { accent } = useTheme();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const submit = useCallback(async () => {
    if (busy || username.trim().length === 0) return;
    Keyboard.dismiss();
    setError(null);
    setBusy(true);
    try {
      await onSubmit(username.trim(), password);
    } catch (e) {
      // The provider already translated this (`login.invalid_username_or_password` and friends);
      // anything without a message still gets a sentence rather than a blank card.
      setError(
        e instanceof Error && e.message
          ? e.message
          : t("login.an_unexpected_error_occurred"),
      );
    } finally {
      setBusy(false);
    }
  }, [busy, username, password, onSubmit, t]);

  // The address form stays reachable on a node — a phone pointed at the wrong server has to be
  // able to leave — but it is not offered as a step. On a node it hides behind Advanced.
  const differentServerLink = onUseDifferentServer ? (
    <Pressable
      testID='login-use-different-server'
      onPress={onUseDifferentServer}
      accessibilityRole='button'
      style={{ paddingVertical: 10, alignSelf: "center" }}
    >
      <Text variant='caption' tone='accent'>
        {t("login.use_different_server")}
      </Text>
    </Pressable>
  ) : null;

  return (
    <View>
      <Text variant={isCompact ? "title" : "display"} weight='bold'>
        {t("login.sign_in")}
      </Text>
      {serverName ? (
        <Text variant='body' tone='secondary' style={{ marginTop: 4 }}>
          {t("login.sign_in_to", { server: serverName })}
        </Text>
      ) : null}

      <View style={{ marginTop: 24, gap: 12 }}>
        <Input
          testID='login-username'
          aria-label={t("login.username_placeholder")}
          placeholder={t("login.username_placeholder")}
          value={username}
          onChangeText={setUsername}
          autoCapitalize='none'
          autoCorrect={false}
          autoComplete='username'
          textContentType='username'
          returnKeyType='next'
          maxLength={500}
          editable={!busy}
          // Enter from the username field submits only once there is a password to send —
          // otherwise it would spend a round trip earning a 401 the user did not ask for.
          onSubmitEditing={() => {
            if (password.length > 0) submit();
          }}
        />
        <View>
          <Input
            testID='login-password'
            aria-label={t("login.password_placeholder")}
            placeholder={t("login.password_placeholder")}
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!revealed}
            autoCapitalize='none'
            autoComplete='current-password'
            textContentType='password'
            returnKeyType='go'
            maxLength={500}
            editable={!busy}
            // Enter submits, on web and on a phone keyboard alike.
            onSubmitEditing={submit}
            style={{ paddingRight: 44 }}
          />
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
        </View>
      </View>

      <Pressable
        onPress={() => onKeepSignedInChange(!keepSignedIn)}
        accessibilityRole='switch'
        accessibilityState={{ checked: keepSignedIn }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingVertical: 12,
        }}
      >
        <Switch
          value={keepSignedIn}
          onValueChange={onKeepSignedInChange}
          trackColor={{ false: tokens.color.bg["3"], true: accent[500] }}
          thumbColor='#FFFFFF'
        />
        <Text variant='body' tone='secondary' style={{ marginLeft: 12 }}>
          {t("login.keep_signed_in")}
        </Text>
      </Pressable>

      <FormError message={error} style={{ marginBottom: 8 }} />

      <Button
        testID='login-submit'
        variant='primary'
        size='lg'
        onPress={submit}
        loading={busy}
        disabled={busy || username.trim().length === 0}
      >
        {t("login.sign_in")}
      </Button>

      {/* Quick Connect never appears on the desktop web login: a code is something you type on a
          television, from the phone in your hand, and offering it beside a password field on a
          desktop is the unexplained icon Dan asked about. */}
      {onSignInWithCode && Platform.OS !== "web" ? (
        <Pressable
          testID='login-sign-in-with-code'
          onPress={onSignInWithCode}
          accessibilityRole='button'
          style={{ paddingVertical: 14, alignSelf: "center" }}
        >
          <Text variant='body' tone='accent'>
            {t("login.sign_in_with_code")}
          </Text>
        </Pressable>
      ) : null}

      {servedByNode ? (
        <View style={{ marginTop: isWebWide ? 12 : 8 }}>
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
          {showAdvanced ? differentServerLink : null}
        </View>
      ) : (
        differentServerLink
      )}
    </View>
  );
};
