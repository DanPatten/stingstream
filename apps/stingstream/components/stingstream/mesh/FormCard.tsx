import type { PropsWithChildren } from "react";
import { View } from "react-native";
import { elevation, radius, tokens } from "@/constants/theme";

/** The card never grows past this, at any window width — same measure `AuthCard` uses. */
const MAX_WIDTH = 480;

/**
 * The centered card Create and Join sit on, echoing `components/login/AuthCard.tsx`'s shape
 * without its wordmark or accent glow — this is a settings sub-page reached after signing in, not
 * a first-impression screen, so it does not need to re-introduce the app.
 */
export function FormCard({ children }: PropsWithChildren) {
  return (
    <View style={{ width: "100%", alignItems: "center" }}>
      <View
        style={[
          {
            width: "100%",
            maxWidth: MAX_WIDTH,
            backgroundColor: tokens.color.bg["1"],
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: tokens.color.border.subtle,
            padding: 24,
          },
          elevation(2),
        ]}
      >
        {children}
      </View>
    </View>
  );
}
