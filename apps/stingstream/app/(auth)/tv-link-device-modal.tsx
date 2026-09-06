import { getQuickConnectApi } from "@jellyfin/sdk/lib/utils/api";
import { BlurView } from "expo-blur";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Animated,
  Easing,
  StyleSheet,
  TVFocusGuideView,
  View,
} from "react-native";
import { Text } from "@/components/common/Text";
import { TVInput } from "@/components/login/TVInput";
import { TVButton } from "@/components/tv/TVButton";
import { useScaledTVTypography } from "@/constants/TVTypography";
import useRouter from "@/hooks/useAppRouter";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import { tvLinkDeviceModalAtom } from "@/utils/atoms/tvLinkDeviceModal";
import { scaleSize } from "@/utils/scaleSize";
import { store } from "@/utils/store";

/** Quick Connect codes are six digits. Anything else cannot be one. */
const CODE_LENGTH = 6;

/**
 * "Link a device": authorise a phone, tablet or browser from the television.
 *
 * The other half of the code sign-in. A device that cannot type a password
 * comfortably — or a browser on somebody else's machine — asks the server for
 * a six-digit code; whoever is already signed in enters it here and the other
 * device is let in as this user. Same `authorizeQuickConnect` call the phone's
 * settings screen makes; only the input is different, because a remote control
 * is the input device.
 *
 * A route, not an overlay: full-screen modals on TV are navigation, never an
 * absolutely positioned view. See docs/tv-modal-guide.md.
 */
export default function TVLinkDeviceModalPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const typography = useScaledTVTypography();
  const modalState = useAtomValue(tvLinkDeviceModalAtom);
  const api = useAtomValue(apiAtom);
  const user = useAtomValue(userAtom);

  const [code, setCode] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "done" | "error">(
    "idle",
  );

  const overlayOpacity = useRef(new Animated.Value(0)).current;
  const sheetTranslateY = useRef(new Animated.Value(200)).current;

  useEffect(() => {
    overlayOpacity.setValue(0);
    sheetTranslateY.setValue(200);

    Animated.parallel([
      Animated.timing(overlayOpacity, {
        toValue: 1,
        duration: 250,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(sheetTranslateY, {
        toValue: 0,
        duration: 300,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();

    // Clear on unmount so a stale server name cannot bleed into the next open.
    return () => {
      store.set(tvLinkDeviceModalAtom, null);
    };
  }, [overlayOpacity, sheetTranslateY]);

  const dismiss = useCallback(() => {
    router.back();
  }, [router]);

  const authorize = useCallback(async () => {
    if (!api || code.length !== CODE_LENGTH) return;
    setStatus("sending");
    try {
      const response = await getQuickConnectApi(api).authorizeQuickConnect({
        code,
        userId: user?.Id,
      });
      if (response.status === 200) {
        setStatus("done");
        return;
      }
      setStatus("error");
    } catch {
      // Jellyfin answers a wrong or expired code with a 4xx, which the SDK
      // throws. There is nothing to tell apart here: either way the code did
      // not work and the viewer needs to read it off the other device again.
      setStatus("error");
    }
  }, [api, code, user?.Id]);

  const canAuthorize = code.length === CODE_LENGTH && status !== "sending";

  return (
    <Animated.View style={[styles.overlay, { opacity: overlayOpacity }]}>
      <Animated.View
        style={[
          styles.sheetContainer,
          { transform: [{ translateY: sheetTranslateY }] },
        ]}
      >
        <BlurView intensity={80} tint='dark' style={styles.blurContainer}>
          <TVFocusGuideView
            autoFocus
            trapFocusUp
            trapFocusDown
            trapFocusLeft
            trapFocusRight
            style={styles.content}
          >
            <Text style={[styles.title, { fontSize: typography.title }]}>
              {t("home.settings.link_device.title")}
            </Text>
            {modalState?.serverName ? (
              <Text style={[styles.subtitle, { fontSize: typography.callout }]}>
                {modalState.serverName}
              </Text>
            ) : null}
            <Text style={[styles.hint, { fontSize: typography.body }]}>
              {t("home.settings.link_device.description")}
            </Text>

            {status === "done" ? (
              <Text style={[styles.success, { fontSize: typography.body }]}>
                {t("home.settings.link_device.linked")}
              </Text>
            ) : (
              <View style={styles.inputWrap}>
                <TVInput
                  style={{
                    fontSize: typography.display,
                    height: undefined,
                    letterSpacing: scaleSize(12),
                    textAlign: "center",
                    paddingVertical: scaleSize(16),
                  }}
                  value={code}
                  onChangeText={(text) =>
                    setCode(text.replace(/\D/g, "").slice(0, CODE_LENGTH))
                  }
                  keyboardType='number-pad'
                  maxLength={CODE_LENGTH}
                  placeholder='------'
                  // The only preferred-focus element on this route: the code is
                  // the one thing to do here, so the remote's number keys land
                  // in the field without a press first.
                  hasTVPreferredFocus
                  autoFocus
                />
              </View>
            )}

            {status === "error" && (
              <Text style={[styles.error, { fontSize: typography.callout }]}>
                {t("home.settings.link_device.invalid_code")}
              </Text>
            )}

            <View style={styles.buttonRow}>
              {status !== "done" && (
                <TVButton
                  onPress={authorize}
                  variant='primary'
                  disabled={!canAuthorize}
                  minHeight={scaleSize(84)}
                >
                  {status === "sending" ? (
                    <ActivityIndicator size='small' color='#000000' />
                  ) : (
                    <Text
                      style={{
                        fontSize: typography.callout,
                        fontWeight: "bold",
                        color: "#000000",
                      }}
                    >
                      {t("home.settings.link_device.authorize")}
                    </Text>
                  )}
                </TVButton>
              )}
              <TVButton
                onPress={dismiss}
                variant='glass'
                minHeight={scaleSize(84)}
              >
                <Text
                  style={{
                    fontSize: typography.callout,
                    fontWeight: "bold",
                    color: "#FFFFFF",
                  }}
                >
                  {status === "done" ? t("common.close") : t("common.cancel")}
                </Text>
              </TVButton>
            </View>
          </TVFocusGuideView>
        </BlurView>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    justifyContent: "flex-end",
  },
  sheetContainer: {
    width: "100%",
  },
  blurContainer: {
    borderTopLeftRadius: scaleSize(24),
    borderTopRightRadius: scaleSize(24),
    overflow: "hidden",
  },
  content: {
    paddingTop: scaleSize(40),
    paddingBottom: scaleSize(56),
    paddingHorizontal: scaleSize(80),
    overflow: "visible",
  },
  title: {
    fontWeight: "700",
    color: "#FFFFFF",
  },
  subtitle: {
    color: "rgba(255,255,255,0.6)",
    marginTop: scaleSize(4),
  },
  hint: {
    color: "rgba(255,255,255,0.8)",
    marginTop: scaleSize(16),
    maxWidth: "70%",
  },
  inputWrap: {
    marginTop: scaleSize(24),
    alignSelf: "flex-start",
    minWidth: scaleSize(420),
  },
  success: {
    marginTop: scaleSize(24),
    color: "#3DDC97",
    fontWeight: "600",
  },
  error: {
    marginTop: scaleSize(12),
    color: "#FF5C5C",
  },
  buttonRow: {
    flexDirection: "row",
    gap: scaleSize(24),
    marginTop: scaleSize(28),
  },
});
