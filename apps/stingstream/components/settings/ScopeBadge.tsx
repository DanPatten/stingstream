import { useTranslation } from "react-i18next";
import { Pill, type PillTone } from "@/components/common/Pill";
import type { SettingsScope } from "@/components/shell/buildSettingsCategories";

/**
 * Who a control is for: this device, your account, or everybody.
 *
 * The answer the old Settings screen never gave. "General" held both this
 * browser's theme and the server's own network addresses, and the two read
 * identically — which is how a viewer's own transcode preference kept being
 * mistaken for a server-wide limit.
 *
 * `server` is the only tone that carries colour. A screen with six saturated
 * badges reads as an error page (see `Pill`), and it is the one scope where
 * being wrong affects somebody other than the reader.
 */
const TONES: Record<SettingsScope, PillTone> = {
  device: "neutral",
  account: "neutral",
  server: "info",
};

export interface ScopeBadgeProps {
  scope: SettingsScope;
  size?: "sm" | "md";
}

/**
 * **Never put one inside a `ListItem`.** A `Pill` in a row truncates the row's
 * own title to make space for itself — confirmed live at 390 px, which is why
 * the "This device" row on the old screen used a subtitle on web. It belongs in
 * a `ScreenHeaderRow`'s `accessory` slot, or above a `ListGroup`.
 */
export const ScopeBadge: React.FC<ScopeBadgeProps> = ({
  scope,
  size = "sm",
}) => {
  const { t } = useTranslation();

  return (
    <Pill
      testID='settings-scope'
      label={t(`home.settings.scope.${scope}`)}
      tone={TONES[scope]}
      size={size}
    />
  );
};
