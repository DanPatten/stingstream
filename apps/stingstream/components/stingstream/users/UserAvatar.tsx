import type { UserDto } from "@jellyfin/sdk/lib/generated-client/models";
import { Image } from "expo-image";
import { View } from "react-native";
import { Icon } from "@/components/common/Icon";
import { useTheme } from "@/hooks/useTheme";
import { getUserImageUrl } from "@/utils/jellyfin/image/getUserImageUrl";

/**
 * The user's own photo, or a fallback tile, so a row with no photo still reads as a person.
 *
 * Shared by the Users screen and the Grant access dialog, which list the same people.
 */
export function UserAvatar({
  serverAddress,
  user,
  size = 36,
}: {
  serverAddress?: string;
  user: UserDto;
  size?: number;
}) {
  const { color } = useTheme();
  const url =
    serverAddress && user.Id
      ? getUserImageUrl({
          serverAddress,
          userId: user.Id,
          primaryImageTag: user.PrimaryImageTag,
          width: size * 2,
        })
      : null;

  if (!url) {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color.bg["3"],
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name='user' size={size * 0.6} tone='tertiary' />
      </View>
    );
  }
  return (
    <Image
      source={{ uri: url }}
      contentFit='cover'
      transition={120}
      style={{ width: size, height: size, borderRadius: size / 2 }}
    />
  );
}
