import { Feather } from "@expo/vector-icons";
import {
  BottomSheetBackdrop,
  type BottomSheetBackdropProps,
  BottomSheetModal,
  BottomSheetView,
} from "@gorhom/bottom-sheet";
import { getQuickConnectApi } from "@jellyfin/sdk/lib/utils/api";
import { requireOptionalNativeModule } from "expo-modules-core";
import { useAtom } from "jotai";
import type React from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Pressable, View, type ViewProps } from "react-native";
import { toast } from "sonner-native";
import { FormError } from "@/components/common/FormError";
import { Text } from "@/components/common/Text";
import { radius, tokens } from "@/constants/theme";
import { useHaptic } from "@/hooks/useHaptic";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import { Button } from "../Button";
import { PinInput } from "../inputs/PinInput";
import { ListGroup } from "../list/ListGroup";
import { ListItem } from "../list/ListItem";

interface Props extends ViewProps {}

/**
 * The authorising half of "sign in with a code": you are already signed in here, and a television
 * across the room is showing six digits.
 *
 * Renamed from `QuickConnect` with the vocabulary (v0.2.0 decisions, "Quick Connect"): the feature
 * underneath is still Jellyfin Quick Connect and the API call is unchanged, but nothing user-facing
 * says so. On the television the same feature is offered as **"Sign in with a code"**; here, on the
 * device doing the approving, it is **"Link a device"**. Never shown on the desktop web *login* —
 * a code you type is something you reach for from the phone in your hand.
 */
export const LinkDevice: React.FC<Props> = ({ ...props }) => {
  const [api] = useAtom(apiAtom);
  const [user] = useAtom(userAtom);
  const [code, setCode] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomSheetModalRef = useRef<BottomSheetModal>(null);
  const successHapticFeedback = useHaptic("success");
  const errorHapticFeedback = useHaptic("error");
  const isAndroid = Platform.OS === "android";
  const snapPoints = useMemo(
    () => (isAndroid ? ["100%"] : ["50%"]),
    [isAndroid],
  );

  const { t } = useTranslation();

  const renderBackdrop = useCallback(
    (backdropProps: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...backdropProps}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
      />
    ),
    [],
  );

  const authorizeQuickConnect = useCallback(async () => {
    if (!code || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await getQuickConnectApi(api!).authorizeQuickConnect({
        code,
        userId: user?.Id,
      });
      if (res.status === 200) {
        successHapticFeedback();
        toast.success(t("home.settings.link_device.linked"));
        setCode("");
        bottomSheetModalRef?.current?.close();
      } else {
        errorHapticFeedback();
        setError(t("home.settings.link_device.invalid_code"));
      }
    } catch {
      // Inline, never an Alert: this sheet renders in a browser too, and `Alert.alert` draws
      // nothing at all there — a wrong code would look like a button that does nothing.
      errorHapticFeedback();
      setError(t("home.settings.link_device.invalid_code"));
    } finally {
      setBusy(false);
    }
  }, [api, user, code, busy, successHapticFeedback, errorHapticFeedback, t]);

  const pasteCode = useCallback(async () => {
    // Builds without the expo-clipboard native module: probe first (no-op).
    if (!requireOptionalNativeModule("ExpoClipboard")) return;
    const Clipboard = await import("expo-clipboard");
    const text = await Clipboard.getStringAsync();
    const digits = (text || "").replace(/\D/g, "").slice(0, 6);
    if (digits) setCode(digits);
  }, []);

  // The ten-foot side of this is `TVLinkCodeScreen`, which shows a code rather than taking one.
  if (Platform.isTV) return null;

  return (
    <View {...props}>
      <ListGroup title={t("home.settings.link_device.title")}>
        <ListItem
          onPress={() => {
            setCode("");
            setError(null);
            bottomSheetModalRef?.current?.present();
          }}
          title={t("home.settings.link_device.enter_code")}
          showArrow
        />
      </ListGroup>

      <BottomSheetModal
        ref={bottomSheetModalRef}
        snapPoints={snapPoints}
        handleIndicatorStyle={{ backgroundColor: tokens.color.text.tertiary }}
        backgroundStyle={{ backgroundColor: tokens.color.bg["1"] }}
        backdropComponent={renderBackdrop}
        keyboardBehavior={isAndroid ? "fillParent" : "interactive"}
        keyboardBlurBehavior='restore'
        android_keyboardInputMode='adjustResize'
        topInset={isAndroid ? 0 : undefined}
      >
        <BottomSheetView>
          <View
            style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32 }}
          >
            <Text variant='heading' weight='bold'>
              {t("home.settings.link_device.title")}
            </Text>
            <Text variant='body' tone='secondary' style={{ marginTop: 8 }}>
              {t("home.settings.link_device.description")}
            </Text>

            <View
              style={{
                marginTop: 20,
                padding: 16,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: tokens.color.border.subtle,
                backgroundColor: tokens.color.bg["2"],
              }}
            >
              <PinInput
                value={code}
                onChangeText={(value) => {
                  setCode(value);
                  setError(null);
                }}
                style={{ paddingHorizontal: 16 }}
                autoFocus
              />
              <Pressable
                onPress={pasteCode}
                accessibilityRole='button'
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  alignSelf: "center",
                  marginTop: 16,
                  paddingVertical: 8,
                  paddingHorizontal: 12,
                }}
              >
                <Feather
                  name='clipboard'
                  size={15}
                  color={tokens.color.text.tertiary}
                />
                <Text
                  variant='caption'
                  tone='tertiary'
                  style={{ marginLeft: 8 }}
                >
                  {t("home.settings.link_device.paste_code")}
                </Text>
              </Pressable>
            </View>

            <FormError message={error} style={{ marginTop: 12 }} />

            <Button
              variant='primary'
              size='lg'
              onPress={authorizeQuickConnect}
              loading={busy}
              disabled={busy || code.length < 6}
              style={{ marginTop: 20 }}
            >
              {t("home.settings.link_device.authorize")}
            </Button>
          </View>
        </BottomSheetView>
      </BottomSheetModal>
    </View>
  );
};
