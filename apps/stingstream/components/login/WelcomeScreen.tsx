import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Button } from "@/components/Button";
import { Icon, type IconName } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useTheme } from "@/hooks/useTheme";

/**
 * The first thing anybody ever sees of StingStream.
 *
 * ## Why there is a screen before the form
 *
 * First run used to open straight on "Create your StingStream account" — a username, a password
 * and a button, with no statement of what had just been installed or what the account was for.
 * That is a fine second screen and a poor first one: somebody who has just run an installer is
 * being asked to invent a credential before anything has said what it belongs to.
 *
 * So this says the three things that are true of every install, whatever its configuration —
 * nothing central, every screen, invite whoever you like — and then hands over to the form.
 *
 * **It is deliberately not a wizard.** Dan's standing instruction on first run is *"no setup step
 * either with that Jellyfin shit"*: libraries, metadata providers and remote access are decided by
 * the node itself. This adds a page to read, not a decision to make, and the only control on it
 * moves forward.
 *
 * It is shown once by construction rather than by remembering anything: it lives in the `welcome`
 * phase, which `decidePhase` only ever returns while the node has no account at all.
 */
export const WelcomeScreen: React.FC<{ onStart: () => void }> = ({
  onStart,
}) => {
  const { t } = useTranslation();
  const { isCompact } = useBreakpoint();
  // The accent is a user setting even here, before there is a user: it is read rather than named
  // so the first screen matches the rest of the app for anybody who has already picked one.
  const { accent } = useTheme();

  /**
   * The three lines, in the order somebody would ask them.
   *
   * Every key written out in full rather than composed from a suffix: `bun run i18n:check` treats a
   * `t(\`setup.${…}\`)` as making the *whole* `setup.` namespace dynamic, and then stops reporting
   * any unused key in it. One weakened guard is a worse trade than three repeated prefixes.
   */
  const points: { icon: IconName; text: string }[] = [
    { icon: "home", text: t("setup.welcome_point_yours") },
    { icon: "devices", text: t("setup.welcome_point_screens") },
    { icon: "invite", text: t("setup.welcome_point_people") },
  ];

  return (
    <View testID='firstrun-welcome'>
      <Text variant={isCompact ? "display" : "title"} weight='bold'>
        {t("setup.welcome_title")}
      </Text>
      <Text variant='body' tone='secondary' style={{ marginTop: 8 }}>
        {t("setup.welcome_body")}
      </Text>

      <View style={{ marginTop: 20, gap: 14 }}>
        {points.map((point) => (
          <View
            key={point.icon}
            style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}
          >
            <Icon name={point.icon} size={18} color={accent[500]} />
            {/* flex: 1 so a long line wraps under itself rather than pushing the icon out of the
                card — which is what it did at 390 before the shrink was allowed. */}
            <Text variant='caption' tone='secondary' style={{ flex: 1 }}>
              {point.text}
            </Text>
          </View>
        ))}
      </View>

      <Button
        testID='firstrun-welcome-start'
        variant='primary'
        size='lg'
        onPress={onStart}
        style={{ marginTop: 24 }}
      >
        {t("setup.welcome_start")}
      </Button>
    </View>
  );
};
