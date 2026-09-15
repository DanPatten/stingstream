import { useEffect } from "react";
import { Platform, View } from "react-native";
import GoogleCast, {
  CastButton,
  CastContext,
  CastState,
  useCastDevice,
  useCastState,
  useDevices,
  useMediaStatus,
  useRemoteMediaClient,
} from "react-native-google-cast";
import { useTheme } from "@/hooks/useTheme";
import { logAndCaptureError } from "@/utils/log";
import { HeaderButton, type HeaderButtonProps } from "./common/HeaderButton";
import { HeaderIcon } from "./common/HeaderIcon";

type Props = Omit<HeaderButtonProps, "onPress" | "children">;

/**
 * Header cast button. Spacing is owned by the surrounding `HeaderButtonGroup` —
 * this component must not carry margins of its own.
 *
 * It is on every phone and narrow-browser header (`components/cast/castHeader.tsx`),
 * which is Google's own guidance for a sender app: the reader should never have
 * to go looking for a way to connect. In a browser the same import is the Cast
 * Web Sender, through the web build of `react-native-google-cast`.
 */
export function Chromecast(props: Props) {
  const { accent } = useTheme();
  const client = useRemoteMediaClient();
  const castDevice = useCastDevice();
  const castState = useCastState();
  const devices = useDevices();
  const sessionManager = GoogleCast.getSessionManager();
  const discoveryManager = GoogleCast.getDiscoveryManager();
  const mediaStatus = useMediaStatus();
  const connected = castState === CastState.CONNECTED;

  useEffect(() => {
    (async () => {
      if (!discoveryManager) {
        console.warn("DiscoveryManager is not initialized");
        return;
      }

      await discoveryManager.startDiscovery();
    })().catch((error) => {
      // Previously an unhandled rejection: cast devices just never appear.
      logAndCaptureError("Chromecast discovery failed to start", error);
    });
  }, [client, devices, castDevice, sessionManager, discoveryManager]);

  return (
    <HeaderButton
      onPress={() => {
        if (mediaStatus?.currentItemId) CastContext.showExpandedControls();
        else CastContext.showCastDialog();
      }}
      {...props}
    >
      {/* Android needs a mounted CastButton for startDiscovery to work, but it
          must not take part in layout or it shifts the icon off the header
          grid — hence absolute + transparent rather than a sibling. */}
      {Platform.OS === "android" ? (
        <View style={{ position: "absolute", opacity: 0 }} pointerEvents='none'>
          <CastButton tintColor='transparent' />
        </View>
      ) : null}
      <HeaderIcon name='cast' tintColor={connected ? accent[500] : undefined} />
    </HeaderButton>
  );
}
