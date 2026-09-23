import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { useQuery } from "@tanstack/react-query";
import { requireOptionalNativeModule } from "expo";
import { useAtomValue } from "jotai";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, StyleSheet, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
import { Text } from "@/components/common/Text";
import { Loader } from "@/components/Loader";
import { useItemQuery } from "@/hooks/useItemQuery";
import { useTheme } from "@/hooks/useTheme";
import { useNodeBaseUrl } from "@/lib/stingstream/client";
import {
  fetchRevealCapability,
  revealFailure,
  revealItem,
  shouldShowReveal,
} from "@/lib/stingstream/reveal";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
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
  const canReveal = useCanReveal(isAdmin);
  const reveal = useMemo<RevealTarget | null>(
    () => (canReveal && item.Id ? { itemId: item.Id } : null),
    [canReveal, item.Id],
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
      {info.general ? <Section section={info.general} reveal={reveal} /> : null}
      {info.versions.map((version, index) => (
        <View key={version.key} style={{ gap: 20 }}>
          {info.general || index > 0 ? <Rule /> : null}
          {version.title ? (
            <Text variant='body' weight='semibold' selectable>
              {version.title}
            </Text>
          ) : null}
          {version.sections.map((section) => (
            <Section key={section.key} section={section} reveal={reveal} />
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

/** "Show in Explorer" is on offer, for this item. */
interface RevealTarget {
  itemId: string;
}

/**
 * Whether this browser can ask the node to open a folder: the web build, an administrator, and a
 * node that says yes to *this* browser, which it does only when the browser is on its own machine.
 * Asked once per node; the answer cannot change without the node restarting.
 */
function useCanReveal(isAdmin: boolean): boolean {
  const nodeBaseUrl = useNodeBaseUrl();
  const worthAsking = shouldShowReveal({
    os: Platform.OS,
    isTV: Platform.isTV,
    isAdmin,
    capability: { canReveal: true, platform: "windows" },
  });
  const { data } = useQuery({
    queryKey: ["stingstream", "reveal", nodeBaseUrl],
    queryFn: () => fetchRevealCapability(nodeBaseUrl ?? ""),
    enabled: worthAsking && !!nodeBaseUrl,
    staleTime: Number.POSITIVE_INFINITY,
  });
  return shouldShowReveal({
    os: Platform.OS,
    isTV: Platform.isTV,
    isAdmin,
    capability: data,
  });
}

const Section: React.FC<{
  section: InfoSection;
  reveal: RevealTarget | null;
}> = ({ section, reveal }) => (
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
          <CopyableRow
            key={row.key}
            row={row}
            reveal={row.revealSourceId ? reveal : null}
          />
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
const CopyableRow: React.FC<{
  row: InfoRow;
  reveal: RevealTarget | null;
}> = ({ row, reveal }) => {
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
      <View style={{ flexDirection: "row", flexWrap: "wrap", marginLeft: -12 }}>
        <Button
          variant='ghost'
          size='sm'
          icon='copy'
          onPress={() => void copyText(row.value, t)}
        >
          {t("item_info.copy_path")}
        </Button>
        {reveal ? (
          <RevealButton itemId={reveal.itemId} sourceId={row.revealSourceId} />
        ) : null}
      </View>
    </View>
  );
};

/** Opens the folder on the server's own desktop. Success needs no word: the window comes up. */
const RevealButton: React.FC<{ itemId: string; sourceId?: string }> = ({
  itemId,
  sourceId,
}) => {
  const { t } = useTranslation();
  const api = useAtomValue(apiAtom);
  const nodeBaseUrl = useNodeBaseUrl();
  const [busy, setBusy] = useState(false);
  const onPress = async () => {
    if (!nodeBaseUrl || !api?.accessToken) {
      toast.error(t("item_info.reveal_failed"));
      return;
    }
    setBusy(true);
    const result = await revealItem(
      nodeBaseUrl,
      api.accessToken,
      itemId,
      sourceId,
    );
    setBusy(false);
    if (!result.ok) {
      toast.error(t(`item_info.reveal_${revealFailure(result.code)}`));
    }
  };
  return (
    <Button
      variant='ghost'
      size='sm'
      icon='reveal'
      loading={busy}
      onPress={() => void onPress()}
    >
      {t("item_info.show_in_explorer")}
    </Button>
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
