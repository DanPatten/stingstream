import {
  ActivityIndicator,
  type ActivityIndicatorProps,
  Platform,
} from "react-native";
import { type TextTone, toneColor } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";

interface Props extends Omit<ActivityIndicatorProps, "color"> {
  /**
   * Defaults to the accent — a spinner is a progress indicator, and progress is
   * accent-coloured everywhere else. Pass `onAccent` inside a filled button,
   * where the accent would be invisible on its own fill.
   */
  tone?: TextTone;
  /** An explicit colour, for a spinner over artwork or a coloured surface. */
  color?: string;
}

/**
 * The spinner.
 *
 * It was Streamyfin's purple (`#9333ea`) on every platform but iOS, which is
 * why a violet ring kept appearing in a teal app long after `Colors.primary`
 * moved (F-29). It follows the user's accent now, like every other progress
 * indicator.
 *
 * **A spinner is for a pending action, not for pending content.** Use
 * `components/common/Skeleton.tsx` for anything that is loading *into* a shape
 * the screen already knows — a row, a grid, a details header. A spinner in
 * place of content tells the user only that something is happening; a skeleton
 * also tells them what is about to arrive, and it does not reflow the page when
 * it does.
 *
 * TV keeps white: `docs/conventions/tv.md` reserves colour on a 10-foot screen
 * for meaning, and a tinted spinner beside a white focus ring competes with it.
 */
export const Loader: React.FC<Props> = ({
  tone = "accent",
  color,
  ...props
}) => {
  const { accentName } = useTheme();

  return (
    <ActivityIndicator
      size='small'
      color={
        color ??
        (Platform.isTV ? toneColor("primary") : toneColor(tone, accentName))
      }
      {...props}
    />
  );
};
