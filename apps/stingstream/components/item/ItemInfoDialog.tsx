import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { requireOptionalNativeModule } from "expo";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Platform, StyleSheet, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
import { Text } from "@/components/common/Text";
import { Loader } from "@/components/Loader";
import { useItemQuery } from "@/hooks/useItemQuery";
import { useTheme } from "@/hooks/useTheme";
import { userAtom } from "@/providers/JellyfinProvider";
import { buildItemInfo, type InfoRow, type InfoSection } from "./mediaInfo";

interface Props {
  item: BaseItemDto;
  visible: boolean;
  onClose: () => void;
}

/** The label column. Wide enough for "Color primaries" without wrapping. */
const LABEL_WIDTH = 132;

/**
 * "Get info": everything the server knows about a title's files, the way Plex's item menu shows
 * it (Dan, 2026-09-22). Read-only, and every value selectable, since the reason to open this is
 * usually to copy something out of it.
 *
 * Not on TV: the details page there is its own screen with no "..." menu, and a read-only wall of
 * codec facts is not a thing anybody reads from a sofa.
 */
export const ItemInfoDialog: React.FC<Props> = ({ item, visible, onClose }) => {
  const { t } = useTranslation();
  const episode =
    item.Type === "Episode" && item.SeriesName ? item.SeriesName : undefined;
  return (
    <Dialog
      visible={visible}
      onClose={onClose}
      title={item.Name ?? t("item.get_info")}
      description={episode}
    >
      {/* Its own component, holding its own query: on a device the dialog is presented once with
          the content it had then, so anything that arrives later has to be fetched in here. */}
      {visible ? <ItemInfoContent item={item} /> : null}
    </Dialog>
  );
};

const ItemInfoContent: React.FC<{ item: BaseItemDto }> = ({ item }) => {
  const { t } = useTranslation();
  const user = useAtomValue(userAtom);
  const isAdmin = Boolean(user?.Policy?.IsAdministrator);

  // Every field, which is what carries MediaSources, MediaStreams and the paths. The same key the
  // details page preloads with, so this is usually already in the cache.
  const { data, isLoading } = useItemQuery(item.Id, false, undefined, []);
  const source = data ?? item;

  const info = useMemo(
    () => buildItemInfo(source, { t, isAdmin }),
    [source, t, isAdmin],
  );

  if (isLoading && !data) {
    return (
      <View style={{ paddingVertical: 32, alignItems: "center" }}>
        <Loader />
      </View>
    );
  }

  return (
    <View style={{ gap: 20, paddingBottom: 4 }}>
      {info.general ? <Section section={info.general} /> : null}
      {info.versions.map((version, index) => (
        <View key={version.key} style={{ gap: 20 }}>
          {info.general || index > 0 ? <Rule /> : null}
          {version.title ? (
            <Text variant='body' weight='semibold' selectable>
              {version.title}
            </Text>
          ) : null}
          {version.sections.map((section) => (
            <Section key={section.key} section={section} />
          ))}
        </View>
      ))}
    </View>
  );
};

const Rule: React.FC = () => {
  const { color } = useTheme();
  return (
    <View
      style={{
        height: StyleSheet.hairlineWidth,
        backgroundColor: color.border.subtle,
      }}
    />
  );
};

const Section: React.FC<{ section: InfoSection }> = ({ section }) => (
  <View>
    <Text
      variant='caption'
      tone='tertiary'
      weight='semibold'
      style={{ marginBottom: section.subtitle ? 2 : 8 }}
    >
      {section.title.toUpperCase()}
    </Text>
    {section.subtitle ? (
      <Text
        variant='caption'
        tone='secondary'
        selectable
        style={{ marginBottom: 8 }}
      >
        {section.subtitle}
      </Text>
    ) : null}
    <View style={{ gap: 6 }}>
      {section.rows.map((row) =>
        row.copyable ? (
          <CopyableRow key={row.key} row={row} />
        ) : (
          <Row key={row.key} row={row} />
        ),
      )}
    </View>
  </View>
);

const Row: React.FC<{ row: InfoRow }> = ({ row }) => (
  <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
    <Text
      variant='body'
      tone='tertiary'
      style={{ width: LABEL_WIDTH, flexShrink: 0, paddingRight: 12 }}
    >
      {row.label}
    </Text>
    <Text variant='body' selectable style={{ flex: 1, minWidth: 0 }}>
      {row.value}
    </Text>
  </View>
);

/** A path: under its label rather than beside it, so it can wrap across the whole card. */
const CopyableRow: React.FC<{ row: InfoRow }> = ({ row }) => {
  const { t } = useTranslation();
  return (
    <View style={{ gap: 4 }}>
      <Text variant='body' tone='tertiary'>
        {row.label}
      </Text>
      <Text
        variant='caption'
        selectable
        style={{
          fontFamily: Platform.select({
            web: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            ios: "Menlo",
            default: "monospace",
          }),
        }}
      >
        {row.value}
      </Text>
      <Button
        variant='ghost'
        size='sm'
        icon='copy'
        onPress={() => void copyText(row.value, t)}
        style={{ alignSelf: "flex-start", marginLeft: -12 }}
      >
        {t("item_info.copy_path")}
      </Button>
    </View>
  );
};

async function copyText(
  text: string,
  t: (key: string) => string,
): Promise<void> {
  if (Platform.OS === "web") {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("item_info.copied"));
    } catch {
      toast.error(t("item_info.copy_failed"));
    }
    return;
  }
  // Builds without the expo-clipboard native module: probe first, as the rest of the app does.
  if (!requireOptionalNativeModule("ExpoClipboard")) {
    toast.error(t("item_info.copy_failed"));
    return;
  }
  const Clipboard = await import("expo-clipboard");
  await Clipboard.setStringAsync(text);
  toast.success(t("item_info.copied"));
}
