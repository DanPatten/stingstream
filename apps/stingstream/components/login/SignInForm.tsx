import { Ionicons } from "@expo/vector-icons";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, Platform, Pressable, View } from "react-native";
import { Button } from "@/components/Button";
import { FormError } from "@/components/common/FormError";
import { Input } from "@/components/common/Input";
import { Switch } from "@/components/common/Switch";
import { Text } from "@/components/common/Text";
import { tokens } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { looksLikeHostname } from "@/lib/stingstream/setup";
import { FocusPressable } from "./FocusPressable";

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
  /**
   * Shown as a "Use a passkey" link, and **only when there is one to use**: the screen passes this
   * in when both this device and this server can do passkeys. A password always works, so the
   * absence of this link is an ordinary state rather than a degraded one.
   *
   * **It takes no username, and that is the change.** It used to, because a central service had to
   * be told which account's credentials to offer. A server's own passkeys are discoverable, so the
   * authenticator already knows which ones it holds for this domain — press the button and you are
   * in, with nothing typed. Which is also why the link is live from the moment the form appears
   * rather than waiting for a field somebody no longer has to fill in.
   */
  onSignInWithPasskey?: () => Promise<void>;
  /**
   * Sign in with an account held on a different StingStream server.
   *
   * The way back in for somebody who accepted an invite here with their own server rather than by
   * choosing a password: that account has no password, so this is not one of several ways in for
   * them, it is the only one.
   */
  onSignInWithOwnServer?: () => void;
  /**
   * Clears the connected server and goes back to the address form.
   *
   * Passed **only** where changing the address means something: a phone or a television, which
   * had to be pointed somewhere in the first place. On a page a node served it is not passed at
   * all — the server is the origin, and it used to hide behind an "Advanced" disclosure that
   * offered to re-type the address already in the URL bar.
   */
  onUseDifferentServer?: () => void;
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
  onSignInWithPasskey,
  onSignInWithOwnServer,
  onUseDifferentServer,
}) => {
  const { t } = useTranslation();
  const { isCompact } = useBreakpoint();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const submitPasskey = useCallback(async () => {
    if (busy || !onSignInWithPasskey) return;
    Keyboard.dismiss();
    setError(null);
    setBusy(true);
    try {
      await onSignInWithPasskey();
    } catch (e) {
      setError(
        e instanceof Error && e.message
          ? e.message
          : t("login.an_unexpected_error_occurred"),
      );
    } finally {
      setBusy(false);
    }
  }, [busy, onSignInWithPasskey, t]);

  // A phone pointed at the wrong server has to be able to leave. Nothing else needs this.
  const differentServerLink = onUseDifferentServer ? (
    <FocusPressable
      testID='login-use-different-server'
      onPress={onUseDifferentServer}
      accessibilityRole='button'
      style={{ paddingVertical: 10, alignSelf: "center" }}
    >
      <Text variant='caption' tone='accent'>
        {t("login.use_different_server")}
      </Text>
    </FocusPressable>
  ) : null;

  // A raw hostname read back as a title is the bug this whole card exists to fix — Jellyfin's
  // `ServerName` defaults to the machine name ("PLEXPC", "DESKTOP-4F2K9QL"), and a name nobody
  // typed is not something to greet a user with. `looksLikeHostname` catches the common shapes;
  // anything else is a name somebody actually gave their node, and is worth showing.
  const subtitle = serverName
    ? looksLikeHostname(serverName)
      ? t("login.sign_in_to_generic")
      : t("login.sign_in_to", { server: serverName })
    : null;

  return (
    <View>
      {/* `title` (26–32 px) from 768 up so "Sign in" never needs `display`'s extra weight in a
          420–460 px card; `display` stays for the phone card, where it is the one headline on the
          screen and the critique called it "the best screen in the app". */}
      <Text variant={isCompact ? "display" : "title"} weight='bold'>
        {t("login.sign_in")}
      </Text>
      {subtitle ? (
        <Text variant='body' tone='secondary' style={{ marginTop: 4 }}>
          {subtitle}
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
              color={tokens.color.text.tertiary}
            />
          </FocusPressable>
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
        {/* `components/common/Switch`, not the bare RN one: the bare control paints iOS
            system-green / Android Material purple, which is how "Keep me signed in" ended up
            white while everything else on the card is teal (critique, F-32). */}
        <Switch value={keepSignedIn} onValueChange={onKeepSignedInChange} />
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

      {/* Under the password button rather than beside it: a passkey is the shortcut, not the
          method, and with no email on an account the password is the credential that always works.
          Live from the moment it is drawn — a server's passkeys are discoverable, so there is
          nothing to type first. */}
      {onSignInWithPasskey ? (
        <FocusPressable
          testID='login-sign-in-with-passkey'
          onPress={() => void submitPasskey()}
          accessibilityRole='button'
          disabled={busy}
          style={{ paddingVertical: 14, alignSelf: "center" }}
        >
          <Text variant='body' tone={busy ? "tertiary" : "accent"}>
            {t("login.sign_in_with_passkey")}
          </Text>
        </FocusPressable>
      ) : null}

      {/* Quick Connect never appears on the desktop web login: a code is something you type on a
          television, from the phone in your hand, and offering it beside a password field on a
          desktop is the unexplained icon Dan asked about. */}
      {onSignInWithCode && Platform.OS !== "web" ? (
        <FocusPressable
          testID='login-sign-in-with-code'
          onPress={onSignInWithCode}
          accessibilityRole='button'
          style={{ paddingVertical: 14, alignSelf: "center" }}
        >
          <Text variant='body' tone='accent'>
            {t("login.sign_in_with_code")}
          </Text>
        </FocusPressable>
      ) : null}

      {/* Last of the alternatives, and deliberately so: it is the least common way in and the only
          one that sends somebody to a different origin. For an account created by a cross-server
          invite it is not an alternative at all — that account has no password — which is why it
          says "my own server" rather than anything about signing in differently. */}
      {onSignInWithOwnServer ? (
        <FocusPressable
          testID='login-sign-in-with-own-server'
          onPress={onSignInWithOwnServer}
          accessibilityRole='button'
          disabled={busy}
          style={{ paddingVertical: 14, alignSelf: "center" }}
        >
          <Text variant='body' tone={busy ? "tertiary" : "accent"}>
            {t("identity.join_own_server_action")}
          </Text>
        </FocusPressable>
      ) : null}

      {differentServerLink}
    </View>
  );
};
