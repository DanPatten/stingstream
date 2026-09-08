import { View } from "react-native";
import { Text } from "@/components/common/Text";
import { useBreakpoint } from "@/hooks/useBreakpoint";

/**
 * "In your library" / "Not in your library" — the two halves one search box answers with.
 *
 * `title`, not the `heading` a `SectionHeader` draws, and that is the whole reason this exists: the
 * rows underneath ("Movies", "Series", "Actors") already use `heading`, so a section label at the
 * same size would read as a fourth row rather than as the thing the rows belong to. One step up the
 * scale is all the hierarchy this needs.
 */
export function SearchSectionTitle({
  title,
  detail,
}: {
  title: string;
  detail?: string;
}) {
  const { gutter } = useBreakpoint();

  return (
    <View style={{ paddingHorizontal: gutter, marginBottom: 12 }}>
      <Text variant='title' weight='semibold'>
        {title}
      </Text>
      {detail ? (
        <Text variant='caption' tone='secondary' style={{ marginTop: 4 }}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}
