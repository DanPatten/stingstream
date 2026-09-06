import { useFonts } from "expo-font";

/**
 * Inter, on web. See `fonts.ts` for why this file exists at all.
 *
 * `useFonts` registers a real `FontFace` per family, so `fontFamily:
 * "Inter-SemiBold"` resolves in the browser exactly as it does on a device.
 * The return value is deliberately ignored by the caller: blocking the whole
 * app on four font downloads would trade a moment of fallback type for a blank
 * page, and the startup budget in the plan is measured to first paint.
 */
export const useInterFonts = (): boolean => {
  const [loaded] = useFonts({
    "Inter-Regular": require("@/assets/fonts/Inter-Regular.ttf"),
    "Inter-Medium": require("@/assets/fonts/Inter-Medium.ttf"),
    "Inter-SemiBold": require("@/assets/fonts/Inter-SemiBold.ttf"),
    "Inter-Bold": require("@/assets/fonts/Inter-Bold.ttf"),
  });
  return loaded;
};
