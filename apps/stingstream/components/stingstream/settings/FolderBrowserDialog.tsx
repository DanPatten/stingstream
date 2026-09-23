import { getEnvironmentApi } from "@jellyfin/sdk/lib/utils/api";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Pressable, ScrollView, View } from "react-native";
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
import { FilterChip } from "@/components/filters/FilterChip";
import { interaction, radius, rgba, space } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { usePressableStates } from "@/hooks/usePressableStates";
import { useTheme } from "@/hooks/useTheme";
import {
  activeRoot,
  addableFolder,
  DRIVES,
  type FolderLookup,
  folderConflict,
  folderName,
  isAbsoluteFolder,
  matchSuggestions,
  normalizeFolder,
  relateFolders,
  rootLabel,
  sidebarRoots,
  suggestionSource,
} from "@/lib/stingstream/folderBrowser";
import { useMediaFolder } from "@/lib/stingstream/libraries";
import { apiAtom } from "@/providers/JellyfinProvider";
import { LoadingState } from "../shared/ScreenState";

/** How long typing has to pause before the list follows the field. */
const TYPE_AHEAD_MS = 250;

const SNAP_POINTS = ["90%"];

/** Below this the sidebar becomes a row of chips above the list. */
const TWO_COLUMN_MIN_WIDTH = 600;

const SIDEBAR_WIDTH = 168;

/** One sentence per collision, keyed by how the new folder stands to the old one. */
const CONFLICT_KEY = {
  same: "libraries.folder_duplicate",
  inside: "libraries.folder_inside",
  contains: "libraries.folder_contains",
} as const;

/**
 * Adding a folder on the server, laid out as Plex's "Add Folder" is.
 *
 * Dan, 2026-09-22, on the one this replaced: *"100% trash"*, and then on the first rebuild, that the
 * up button and its icon were confusing. So there is none: the path field is at the top, a sidebar
 * on the left holds the node's media folder (the house) and one entry per drive, and the list on
 * the right holds the subfolders of wherever the field points. Going up is a sidebar entry or an
 * edit of the field, exactly as in Plex.
 *
 * The field is the one source of truth. The list follows it as you type (debounced), a row or a
 * sidebar entry puts its path into it, and Add adds what it says. The first version's Select added
 * the last folder the list had shown and ignored what was typed, which was the whole of the
 * "couldn't add it ... said it overlapped" report. See `addableFolder`.
 *
 * Home is the node's media folder (`<data>\media`), never the account's home: the Windows service
 * runs as LocalSystem, whose profile is under System32.
 *
 * The listing is the media server's own `/Environment/Drives` and `/Environment/DirectoryContents`,
 * so it is the server's disks that are shown. The browser's native directory picker cannot do that
 * and is deliberately not used.
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
  /** Where to open. The node's media folder when omitted. */
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
      webMaxWidth={760}
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

interface Place {
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
  const { width } = useBreakpoint();
  const api = useAtomValue(apiAtom);
  const media = useMediaFolder();
  const home = media.data ?? null;
  const start = normalizeFolder(initialPath ?? "");
  /** What the field says. The one source of truth for what Add adds. */
  const [draft, setDraft] = useState(start);
  /** The field, once typing has paused: what the list is showing. */
  const [target, setTarget] = useState(start);
  /** A row picked with the arrow keys, or -1. */
  const [highlight, setHighlight] = useState(-1);
  const [rejection, setRejection] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const touched = useRef(start !== DRIVES);

  const go = (next: string) => {
    const path = normalizeFolder(next);
    touched.current = true;
    setDraft(path);
    setTarget(path);
    setRejection(null);
  };

  // No folder of its own yet: open on the media folder, once the node has said where it is.
  useEffect(() => {
    if (!touched.current && home) {
      touched.current = true;
      const path = normalizeFolder(home);
      setDraft(path);
      setTarget(path);
    }
  }, [home]);

  useEffect(() => {
    const next = normalizeFolder(draft);
    if (next === target) return;
    const timer = setTimeout(() => setTarget(next), TYPE_AHEAD_MS);
    return () => clearTimeout(timer);
  }, [draft, target]);

  useEffect(() => setHighlight(-1), [target]);

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

  const drives = useQuery({
    queryKey: ["stingstream", "folder-browser", DRIVES],
    queryFn: list(DRIVES),
    enabled: !!api,
    retry: false,
    staleTime: 10_000,
  });

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
  const rows: Place[] = entries.map((entry) => ({
    key: entry.Path!,
    label: listingDrives ? rootLabel(entry.Path!) : folderName(entry.Path!),
    path: entry.Path!,
    icon: "folder",
  }));

  const roots = sidebarRoots(
    (drives.data ?? []).map((entry) => entry.Path!),
    home,
  );
  const places: Place[] = [
    ...(home
      ? [
          {
            key: "home",
            label: t("libraries.browse_home"),
            path: home,
            icon: "home" as IconName,
          },
        ]
      : []),
    ...roots.map((root) => ({
      key: root,
      label: rootLabel(root),
      path: root,
      icon: "folder" as IconName,
    })),
  ];
  const selectedPlace = activeRoot(
    target,
    places.map((place) => place.path),
  );

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
    rows.length === 0 &&
    (lookup === "loading" || (suggesting && parent.isLoading));
  const wide = width >= TWO_COLUMN_MIN_WIDTH;

  const folderList = (
    <View
      style={{
        flex: 1,
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
              testID='folder-browser-entry'
              label={row.label}
              icon={row.icon}
              highlighted={index === highlight}
              onPress={() => go(row.path)}
            />
          ))}
          {rows.length === 0 &&
          (here.isSuccess || (suggesting && parent.isSuccess)) ? (
            <Text
              variant='body'
              tone='secondary'
              style={{ padding: space["4"] }}
            >
              {here.isSuccess
                ? t("libraries.browse_empty")
                : t("libraries.browse_no_matches")}
            </Text>
          ) : null}
        </SheetScrollView>
      )}
    </View>
  );

  return (
    <SheetView
      style={{
        flex: 1,
        paddingHorizontal: 24,
        paddingTop: 20,
        paddingBottom: 20,
        gap: space["4"],
      }}
    >
      <View
        style={{ flexDirection: "row", alignItems: "center", gap: space["3"] }}
      >
        <FolderPlusGlyph />
        <Text variant='heading' weight='semibold' style={{ flex: 1 }}>
          {t("libraries.browse_title")}
        </Text>
        <CloseButton label={t("common.close")} onPress={onClose} />
      </View>

      <View>
        <Input
          testID='folder-browser-path'
          accessibilityLabel={t("libraries.browse_path")}
          placeholder={t("libraries.browse_path")}
          value={draft}
          onChangeText={(value) => {
            touched.current = true;
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

      {wide ? (
        <View
          style={{
            // A fixed height rather than flex: the web card has none until its content gives it
            // one, and a long folder list would otherwise push the footer out of the card.
            height: 360,
            flexDirection: "row",
            gap: space["3"],
          }}
        >
          <View style={{ width: SIDEBAR_WIDTH, gap: 2 }}>
            {places.map((place) => (
              <SidebarRow
                key={place.key}
                testID={`folder-browser-place-${place.key}`}
                label={place.label}
                icon={place.icon}
                selected={place.path === selectedPlace}
                onPress={() => go(place.path)}
              />
            ))}
          </View>
          {folderList}
        </View>
      ) : (
        <View style={{ height: 360, gap: space["3"] }}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: space["2"] }}
            style={{ flexGrow: 0 }}
          >
            {places.map((place) => (
              <FilterChip
                key={place.key}
                testID={`folder-browser-place-${place.key}`}
                label={place.label}
                icon={place.icon}
                iconPosition='start'
                active={place.path === selectedPlace}
                onPress={() => go(place.path)}
              />
            ))}
          </ScrollView>
          {folderList}
        </View>
      )}

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
        <Button variant='secondary' size='md' onPress={onClose}>
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

/** Plex's folder-plus. Ionicons has no such glyph, so it is a folder with an add badge. */
function FolderPlusGlyph() {
  const { color, accent } = useTheme();
  return (
    <View style={{ width: 26, height: 24 }}>
      <Icon name='folder' size={22} color={color.text.secondary} />
      <View
        style={{
          position: "absolute",
          right: 0,
          bottom: 0,
          width: 13,
          height: 13,
          borderRadius: 7,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: accent[500],
        }}
      >
        <Icon name='add' size={11} color={accent.onAccent} />
      </View>
    </View>
  );
}

function CloseButton({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  const { color } = useTheme();
  const states = usePressableStates();
  return (
    <Pressable
      testID='folder-browser-close'
      accessibilityRole='button'
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      {...states.handlers}
      style={[
        {
          width: 32,
          height: 32,
          borderRadius: 16,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: states.overlay ?? "transparent",
        },
        states.webStyle,
      ]}
    >
      <Icon name='close' size={20} color={color.text.secondary} />
    </Pressable>
  );
}

/** A sidebar entry. Selected is an accent bar on the left edge over a raised background. */
function SidebarRow({
  label,
  icon,
  selected,
  onPress,
  testID,
}: {
  label: string;
  icon: IconName;
  selected: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const { color, accent } = useTheme();
  const states = usePressableStates();
  return (
    <Pressable
      testID={testID}
      accessibilityRole='button'
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      {...states.handlers}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: space["3"],
          minHeight: 40,
          paddingLeft: space["3"],
          paddingRight: space["2"],
          borderRadius: radius.sm,
          overflow: "hidden",
          backgroundColor: selected
            ? color.bg["3"]
            : (states.overlay ?? "transparent"),
        },
        states.webStyle,
      ]}
    >
      {selected ? (
        <View
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: 3,
            backgroundColor: accent[500],
          }}
        />
      ) : null}
      <Icon
        name={icon}
        size={18}
        color={selected ? accent[500] : color.text.secondary}
      />
      <Text
        variant='body'
        weight={selected ? "semibold" : undefined}
        numberOfLines={1}
        style={{ flex: 1 }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function FolderRow({
  label,
  icon,
  highlighted,
  onPress,
  testID,
}: {
  label: string;
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
      accessibilityLabel={label}
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
    </Pressable>
  );
}
