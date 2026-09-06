/**
 * The pre-play way into "Play from…", beside the media-options button on the details page.
 *
 * Renders nothing unless the title is actually federated and there is more than one holder to
 * choose between: on a single-server library this button would be a permanent dead end, and the
 * question it asks ("which of your servers?") does not exist there.
 */

import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { type FC, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Pressable, View } from "react-native";
import { Icon } from "@/components/common/Icon";
import { radius, rgba, tokens } from "@/constants/theme";
import { useSourceChoices } from "@/hooks/useItemSources";
import { useTheme } from "@/hooks/useTheme";
import { SourceChooserSheet } from "./SourceChooserSheet";

export interface SourceChooserButtonProps {
  item?: BaseItemDto | null;
  currentMediaSourceId?: string | null;
  /** Adopt the chosen source for the play that follows. */
  onSelect: (mediaSourceId: string) => void;
}

export const SourceChooserButton: FC<SourceChooserButtonProps> = ({
  item,
  currentMediaSourceId,
  onSelect,
}) => {
  const { t } = useTranslation();
  const { accent } = useTheme();
  const [open, setOpen] = useState(false);
  // The list is fetched here as well as inside the sheet so the button can decide whether to
  // exist. React Query dedupes the two on one key, so it is one request.
  const { hasChoice } = useSourceChoices(item, { currentMediaSourceId });

  if (!hasChoice) return null;

  return (
    <>
      <Pressable
        testID='details-play-from'
        onPress={() => setOpen(true)}
        accessibilityRole='button'
        accessibilityLabel={t("player.source.play_from")}
        style={({ pressed }) => [
          {
            width: 48,
            height: 48,
            borderRadius: radius.pill,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: pressed
              ? rgba(accent[500], 0.35)
              : tokens.color.bg["2"],
          },
          Platform.OS === "web" ? ({ cursor: "pointer" } as never) : null,
        ]}
      >
        <View>
          <Icon name='sharing' size={22} tone='primary' />
        </View>
      </Pressable>
      <SourceChooserSheet
        visible={open}
        onClose={() => setOpen(false)}
        item={item}
        currentMediaSourceId={currentMediaSourceId}
        onSelect={onSelect}
      />
    </>
  );
};
