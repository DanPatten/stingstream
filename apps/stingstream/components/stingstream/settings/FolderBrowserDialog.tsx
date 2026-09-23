import { getEnvironmentApi } from "@jellyfin/sdk/lib/utils/api";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Pressable, View } from "react-native";
import { Button } from "@/components/Button";
import { Icon, type IconName } from "@/components/common/Icon";
import { Input } from "@/components/common/Input";
import {
  SheetBackdrop,
  type SheetBackdropProps,
  SheetModal,
  type SheetModalRef,
  SheetScrollView,
  SheetView,
} from "@/components/common/Sheet";
import { Text } from "@/components/common/Text";
import { interaction, radius, rgba, space } from "@/constants/theme";
import { usePressableStates } from "@/hooks/usePressableStates";
import { useTheme } from "@/hooks/useTheme";
import {
  addableFolder,
  DRIVES,
  type FolderLookup,
  folderConflict,
  folderName,
  isAbsoluteFolder,
  matchSuggestions,
  normalizeFolder,
  parentPath,
  relateFolders,
  suggestionSource,
} from "@/lib/stingstream/folderBrowser";
import { apiAtom } from "@/providers/JellyfinProvider";
import { LoadingState } from "../shared/ScreenState";

/** How long typing has to pause before the list follows the field. */
const TYPE_AHEAD_MS = 250;

const SNAP_POINTS = ["85%"];

/** One sentence per collision, keyed by how the new folder stands to the old one. */
const CONFLICT_KEY = {
  same: "libraries.folder_duplicate",
  inside: "libraries.folder_inside",
  contains: "libraries.folder_contains",
} as const;

/**
 * Adding a folder on the server, the way Plex's "Add folders" does it.
 *
 * Dan, 2026-09-22, on the one this replaced: *"100% trash"*. It had a path box and a list that
 * disagreed with each other: Select added the last folder the *list* had shown and ignored what
 * was typed, so a typed folder was either a silent no-op or, after pressing Up, the parent folder,
 * which the node then refused as an overlap. Here there is one source of truth, the path field:
 * the list follows it as you type (debounced), a row puts its path into it, and Add adds what it
 * says. See `addableFolder` in `lib/stingstream/folderBrowser.ts`.
 *
 * The listing is the media server's own `/Environment/Drives` and `/Environment/DirectoryContents`,
 * so it is the server's disks that are shown, not the device holding the browser. The browser's
 * native directory picker cannot do that and is deliberately not used.
 *
 * `onAdd` does the saving. It throws to refuse, and the refusal is shown under the field with the
 * dialog left open, so an add never fails silently.
 */
export function FolderBrowserDialog({
  visible,
  initialPath,
  existing = [],
  onClose,
  onAdd,
}: {
  visible: boolean;
  /** Where to open. The drive list when omitted. */
  initialPath?: string;
  /** The folders the library already holds, checked before anything is sent. */
  existing?: readonly string[];
  onClose: () => void;
  /** Save it. Throw to keep the dialog open with the reason shown. */
  onAdd: (path: string) => Promise<void> | void;
}) {
  const { color } = useTheme();
  const ref = useRef<SheetModalRef>(null);

  useEffect(() => {
    if (visible) ref.current?.present();
    else ref.current?.dismiss();
  }, [visible]);

  return (
    <SheetModal
      ref={ref}
      snapPoints={SNAP_POINTS}
      enableDynamicSizing={false}
      onChange={(index) => {
        if (index === -1) onClose();
      }}
      backdropComponent={Backdrop}
      backgroundStyle={{ backgroundColor: color.bg["1"] }}
      handleIndicatorStyle={{ backgroundColor: color.text.tertiary }}
      keyboardBehavior='interactive'
      keyboardBlurBehavior='restore'
      webMaxWidth={640}
    >
      {/* Mounted only while open, so every opening starts from a clean field. */}
      {visible ? (
        <FolderBrowserBody
          initialPath={initialPath}
          existing={existing}
          onClose={onClose}
          onAdd={onAdd}
        />
      ) : null}
    </SheetModal>
  );
}

function Backdrop(props: SheetBackdropProps) {
  return <SheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />;
}

interface Row {
  key: string;
  label: string;
  path: string;
  icon: IconName;
}

function FolderBrowserBody({
  initialPath,
  existing,
  onClose,
  onAdd,
}: {
  initialPath?: string;
  existing: readonly string[];
  onClose: () => void;
  onAdd: (path: string) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const { color } = useTheme();
  const api = useAtomValue(apiAtom);
  const start = normalizeFolder(initialPath ?? "");
  /** What the field says. The one source of truth for what Add adds. */
  const [draft, setDraft] = useState(start);
  /** The field, once typing has paused: what the list is showing. */
  const [target, setTarget] = useState(start);
  /** A row picked with the arrow keys, or -1. */
  const [highlight, setHighlight] = useState(-1);
  const [rejection, setRejection] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    const next = normalizeFolder(draft);
    if (next === target) return;
    const timer = setTimeout(() => setTarget(next), TYPE_AHEAD_MS);
    return () => clearTimeout(timer);
  }, [draft, target]);

  useEffect(() => setHighlight(-1), [target]);

  const go = (next: string) => {
    const path = normalizeFolder(next);
    setDraft(path);
    setTarget(path);
    setRejection(null);
  };

  const list = (path: string) => async () => {
    const environment = getEnvironmentApi(api!);
    const response =
      path === DRIVES
        ? await environment.getDrives()
        : await environment.getDirectoryContents({
            path,
            includeDirectories: true,
            includeFiles: false,
          });
    return (response.data ?? [])
      .filter((entry) => entry.Path)
      .sort((a, b) =>
        (a.Name ?? "").localeCompare(b.Name ?? "", undefined, {
          sensitivity: "base",
        }),
      );
  };

  const listable = target === DRIVES || isAbsoluteFolder(target);
  const here = useQuery({
    queryKey: ["stingstream", "folder-browser", target],
    queryFn: list(target),
    enabled: !!api && listable,
    retry: false,
    staleTime: 10_000,
  });

  // When the field does not name a folder that can be listed, it is probably half typed: look in
  // its parent for names that start with the last segment.
  const source = suggestionSource(target);
  const suggesting = !listable || here.isError;
  const parent = useQuery({
    queryKey: ["stingstream", "folder-browser", source.parent],
    queryFn: list(source.parent),
    enabled:
      !!api &&
      suggesting &&
      (source.parent === DRIVES || isAbsoluteFolder(source.parent)),
    retry: false,
    staleTime: 10_000,
  });

  const settled = normalizeFolder(draft) === target;
  const lookup: FolderLookup = !settled
    ? "loading"
    : target === DRIVES || here.isSuccess
      ? "listed"
      : !here.isError
        ? "loading"
        : parent.isSuccess
          ? "missing"
          : parent.isError
            ? "missing_parent"
            : "loading";
  const addable = addableFolder(draft, lookup);

  const entries = here.isSuccess
    ? here.data
    : suggesting && parent.isSuccess
      ? matchSuggestions(parent.data, source.prefix)
      : [];
  const listingDrives = here.isSuccess
    ? target === DRIVES
    : source.parent === DRIVES;
  const rows: Row[] = [
    ...(target !== DRIVES
      ? [
          {
            key: "..",
            label: "..",
            path: parentPath(target),
            icon: "chevronUp" as IconName,
          },
        ]
      : []),
    ...entries.map((entry) => ({
      key: entry.Path!,
      label: listingDrives
        ? entry.Name || entry.Path!
        : folderName(entry.Path!),
      path: entry.Path!,
      icon: "storage" as IconName,
    })),
  ];

  // The folder is not listable but its parent says it is there: it exists and cannot be opened,
  // which is a different thing to say from "it will be created".
  const unreadable =
    lookup === "missing" &&
    (parent.data ?? []).some(
      (entry) => relateFolders(entry.Path ?? "", target) === "same",
    );

  const fieldError =
    rejection ??
    (addable.reason === "not_found"
      ? t("libraries.browse_not_found")
      : addable.reason === "not_absolute" && settled && entries.length === 0
        ? t("libraries.browse_not_absolute")
        : null);
  const fieldHint =
    fieldError || lookup !== "missing"
      ? null
      : unreadable
        ? t("libraries.browse_error")
        : t("libraries.browse_new_folder");

  const submit = async () => {
    if (!addable.path || adding) return;
    const conflict = folderConflict(existing, addable.path);
    if (conflict) {
      setRejection(t(CONFLICT_KEY[conflict.relation], { path: conflict.path }));
      return;
    }
    setRejection(null);
    setAdding(true);
    try {
      await onAdd(addable.path);
    } catch (err) {
      setAdding(false);
      setRejection(
        err instanceof Error && err.message
          ? err.message
          : t("libraries.save_error"),
      );
      return;
    }
    setAdding(false);
    onClose();
  };

  const onKey = (key: string, preventDefault: () => void) => {
    if (key === "ArrowDown") {
      preventDefault();
      setHighlight((h) => Math.min(h + 1, rows.length - 1));
    } else if (key === "ArrowUp") {
      preventDefault();
      setHighlight((h) => Math.max(h - 1, -1));
    }
  };

  const loading =
    rows.length <= 1 &&
    (lookup === "loading" || (suggesting && parent.isLoading));

  return (
    <SheetView
      style={{
        flex: 1,
        paddingHorizontal: 24,
        paddingTop: 20,
        paddingBottom: 20,
        gap: space["3"],
      }}
    >
      <Text variant='heading' weight='semibold'>
        {t("libraries.browse_title")}
      </Text>

      <View>
        <Input
          testID='folder-browser-path'
          accessibilityLabel={t("libraries.browse_path")}
          placeholder={t("libraries.browse_path")}
          icon='storage'
          value={draft}
          onChangeText={(value) => {
            setDraft(value);
            setRejection(null);
          }}
          onSubmitEditing={() => {
            const row = highlight >= 0 ? rows[highlight] : undefined;
            go(row ? row.path : draft);
          }}
          onKeyPress={(event) => {
            const native = event.nativeEvent as { key?: string };
            onKey(native.key ?? "", () =>
              (
                event as unknown as { preventDefault?: () => void }
              ).preventDefault?.(),
            );
          }}
          autoFocus={Platform.OS === "web"}
          autoCapitalize='none'
          autoCorrect={false}
          error={fieldError}
          editable={!adding}
        />
        {fieldHint ? (
          <Text
            variant='caption'
            tone='secondary'
            style={{ marginTop: space["2"] }}
          >
            {fieldHint}
          </Text>
        ) : null}
      </View>

      <View
        style={{
          height: 300,
          borderRadius: radius.md,
          overflow: "hidden",
          backgroundColor: color.bg["2"],
        }}
      >
        {loading ? (
          <LoadingState rows={5} />
        ) : (
          <SheetScrollView keyboardShouldPersistTaps='handled'>
            {rows.map((row, index) => (
              <FolderRow
                key={row.key}
                testID={
                  row.key === ".."
                    ? "folder-browser-up"
                    : "folder-browser-entry"
                }
                label={row.label}
                accessibilityLabel={
                  row.key === ".." ? t("libraries.browse_up") : row.label
                }
                icon={row.icon}
                highlighted={index === highlight}
                onPress={() => go(row.path)}
              />
            ))}
            {entries.length === 0 && lookup !== "missing_parent" ? (
              <Text
                variant='body'
                tone='secondary'
                style={{ padding: space["4"] }}
              >
                {here.isSuccess
                  ? t("libraries.browse_empty")
                  : suggesting && parent.isSuccess
                    ? t("libraries.browse_no_matches")
                    : null}
              </Text>
            ) : null}
          </SheetScrollView>
        )}
      </View>

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: space["2"],
        }}
      >
        {addable.reason === "choose" ? (
          <Text variant='caption' tone='secondary' style={{ flex: 1 }}>
            {t("libraries.browse_choose")}
          </Text>
        ) : null}
        <Button variant='ghost' size='md' onPress={onClose}>
          {t("libraries.cancel")}
        </Button>
        <Button
          testID='folder-browser-add'
          variant='primary'
          size='md'
          loading={adding}
          disabled={!addable.path || adding}
          onPress={() => void submit()}
        >
          {t("libraries.browse_add")}
        </Button>
      </View>
    </SheetView>
  );
}

function FolderRow({
  label,
  accessibilityLabel,
  icon,
  highlighted,
  onPress,
  testID,
}: {
  label: string;
  accessibilityLabel: string;
  icon: IconName;
  highlighted: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const { color } = useTheme();
  const states = usePressableStates();
  const wash = highlighted
    ? rgba(color.overlay, interaction.hoverOverlay)
    : states.overlay;

  return (
    <Pressable
      testID={testID}
      accessibilityRole='button'
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      {...states.handlers}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: space["3"],
          minHeight: 44,
          paddingHorizontal: space["4"],
          paddingVertical: space["2"],
          backgroundColor: wash ?? "transparent",
        },
        states.webStyle,
      ]}
    >
      <Icon name={icon} size={18} color={color.text.secondary} />
      <Text variant='body' numberOfLines={1} style={{ flex: 1 }}>
        {label}
      </Text>
      <Icon name='chevronRight' size={16} color={color.text.tertiary} />
    </Pressable>
  );
}
