import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { SettingSwitch } from "@/components/common/SettingSwitch";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { radius } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import {
  type QualityProfileView,
  useDeleteQualityProfile,
  useQualityProfiles,
  useQualityVocabulary,
  useSaveQualityProfile,
} from "@/lib/stingstream/hooks";
import { arrAppLabel } from "../shared/arrLabels";
import { confirmDestructive } from "../shared/confirm";
import { ScreenHeaderRow } from "../shared/ScreenHeaderRow";
import { EmptyState, QueryState } from "../shared/ScreenState";
import { SaveStatus } from "./fields";
import {
  availableGroups,
  inGroup,
  isPresetPresent,
  PRESETS,
  type QualityPreset,
  resolvePreset,
} from "./qualityPresets";
import { useAutosave } from "./useAutosave";

/**
 * Server settings → Quality profiles. Gap 4 closed.
 *
 * A profile is one thing with one name, written wherever this server fetches from — which is why
 * there is no picker for that here. What films and series do not share is the quality vocabulary
 * itself, so the editor offers the *shared* names by default and says plainly when a profile asks
 * for something one half does not have (`Unsupported`) or when the two have drifted apart
 * (`InSync`). Both are real states somebody needs to see, not errors to hide.
 *
 * **Nothing on this screen is typed.** Making a profile used to mean inventing a name and then
 * ticking boxes from a list of nineteen strings like `WEBRip-720p` — a downloader's vocabulary,
 * not anything a person watching television has an opinion about. A profile's name is also its
 * identity in what it is written to and cannot be changed afterwards, so a typo is permanent.
 * Profiles now come from `qualityPresets`, formats are added a group at a time, and the default is
 * chosen from the profiles that exist rather than spelled out again.
 */
export function QualityProfilesSection({
  value,
  onSave,
  saving,
}: {
  /** The shared settings' default-profile name, still edited here. */
  value: string;
  onSave: (next: string) => Promise<void>;
  saving: boolean;
}) {
  const { color } = useTheme();
  const { t } = useTranslation();
  const [editing, setEditing] = useState<QualityProfileView | null>(null);
  const [creating, setCreating] = useState(false);
  const profiles = useQualityProfiles();
  const remove = useDeleteQualityProfile();

  // Picking a pill *is* the decision, so it goes at once rather than waiting for a pause that will
  // never come — there is nothing here anybody types.
  const {
    draft,
    set,
    saving: sending,
  } = useAutosave({
    value,
    save: async (next) => {
      try {
        await onSave(next);
        toast.success(
          t("server_settings.quality_profiles_default_saved_toast"),
        );
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : t("server_settings.save_error"),
        );
      }
    },
  });

  const del = async (name: string) => {
    const ok = await confirmDestructive(
      t("server_settings.quality_profiles_delete_confirm_title", { name }),
      t("server_settings.quality_profiles_delete_confirm_message"),
    );
    if (!ok) return;
    try {
      const result = await remove.mutateAsync(name);
      toast.success(
        result?.Detail?.join("; ") ||
          t("server_settings.quality_profiles_deleted_toast"),
      );
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("server_settings.quality_profiles_delete_error"),
      );
    }
  };

  return (
    <View>
      <ScreenHeaderRow
        title={t("server_settings.quality_profiles_title")}
        accessory={
          <Button
            variant='secondary'
            size='sm'
            icon={creating ? "close" : "add"}
            onPress={() => {
              setEditing(null);
              setCreating((v) => !v);
            }}
          >
            {creating
              ? t("common.cancel")
              : t("server_settings.quality_profiles_new_action")}
          </Button>
        }
      />

      {creating && (
        <PresetPicker
          existing={(profiles.data ?? []).map((p) => p.Name ?? "")}
          onDone={() => setCreating(false)}
        />
      )}

      <QueryState
        isLoading={profiles.isLoading}
        error={profiles.error}
        onRetry={profiles.refetch}
      >
        {(profiles.data ?? []).length === 0 ? (
          <EmptyState
            title={t("server_settings.quality_profiles_empty_title")}
            detail={t("server_settings.quality_profiles_empty_detail")}
          />
        ) : (
          <ListGroup>
            {(profiles.data ?? []).map((p) => (
              <View key={p.Name}>
                <ListItem
                  title={p.Name ?? ""}
                  subtitle={describe(t, p)}
                  subtitleColor={p.InSync === false ? "red" : "default"}
                  value={
                    p.IsDefault
                      ? t("server_settings.quality_profiles_default_value")
                      : undefined
                  }
                  showArrow
                  onPress={() =>
                    setEditing(editing?.Name === p.Name ? null : p)
                  }
                />
                {editing?.Name === p.Name && (
                  <View
                    style={{
                      backgroundColor: color.bg["2"],
                      paddingHorizontal: 16,
                      paddingVertical: 12,
                    }}
                  >
                    <ProfileEditor
                      initial={p}
                      onDone={() => setEditing(null)}
                    />
                    <Pressable
                      style={{ marginTop: 12 }}
                      onPress={() => void del(p.Name ?? "")}
                    >
                      <Text tone='danger' weight='semibold'>
                        {t("server_settings.quality_profiles_delete_action")}
                      </Text>
                    </Pressable>
                  </View>
                )}
              </View>
            ))}
          </ListGroup>
        )}
      </QueryState>

      <View style={{ height: 16 }} />

      {/*
        A chooser, not a text field. This names the profile everything new is filed under, and it
        used to be typed -- so a single typo silently pointed the whole server at a profile that
        does not exist, with nothing on screen to say so.
      */}
      <ListGroup
        title={t("server_settings.quality_profiles_default_name_title")}
      >
        <View style={{ padding: 12 }}>
          <Text variant='caption' tone='secondary' style={{ marginBottom: 8 }}>
            {t("server_settings.quality_profiles_default_name_detail")}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {(profiles.data ?? []).map((p) => (
              <ChoicePill
                key={p.Name}
                label={p.Name ?? ""}
                selected={draft === p.Name}
                onPress={() => set(() => p.Name ?? "", { now: true })}
              />
            ))}
            {(profiles.data ?? []).length === 0 && (
              <Text variant='caption' tone='secondary'>
                {t("server_settings.quality_profiles_default_none")}
              </Text>
            )}
          </View>
        </View>
      </ListGroup>
      <SaveStatus saving={saving || sending} />
    </View>
  );
}

/**
 * A pill that is a choice, not a text field.
 *
 * The one shape every control on this screen now takes: formats, format groups, the cutoff, and
 * which profile is the default. Shared so they cannot drift apart -- four near-identical
 * `Pressable`s with hand-written colors is how three of them ended up looking like buttons and
 * one like a tag.
 */
function ChoicePill({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const { color, accent } = useTheme();
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: radius.pill,
        backgroundColor: selected ? accent[500] : color.bg["3"],
      }}
    >
      <Text
        variant='caption'
        weight='semibold'
        tone={selected ? "onAccent" : "secondary"}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The four ready-made profiles, offered instead of a blank editor.
 *
 * Pressing one writes it and is done -- there is no second step, because the whole point is that
 * somebody who wants "the everyday one" should not have to have an opinion about `WEBRip-720p`.
 * What it resolves to on *this* server is shown underneath, so the choice is not blind, and the
 * profile it makes can be opened and adjusted afterwards like any other.
 *
 * A preset already on the server is shown as such rather than hidden: its absence would read as
 * the list being wrong, and hiding things people expect to see is how a screen becomes a puzzle.
 */
function PresetPicker({
  existing,
  onDone,
}: {
  existing: string[];
  onDone: () => void;
}) {
  const { color } = useTheme();
  const { t } = useTranslation();
  const vocabulary = useQualityVocabulary();
  const save = useSaveQualityProfile();
  const [pending, setPending] = useState<string | null>(null);

  const names = useMemo(() => vocabulary.data?.Shared ?? [], [vocabulary.data]);

  const add = async (preset: QualityPreset) => {
    const resolved = resolvePreset(preset, names);
    if (!resolved) {
      toast.error(t("server_settings.quality_presets_unavailable"));
      return;
    }
    setPending(preset.key);
    try {
      const result = await save.mutateAsync({
        isNew: true,
        profile: {
          Name: preset.name,
          UpgradeAllowed: true,
          Cutoff: resolved.cutoff,
          Items: resolved.allowed.map((q) => ({ Name: q, Allowed: true })),
        },
      });
      toast.success(
        result?.Detail?.join("; ") ||
          t("server_settings.quality_presets_added", { name: preset.name }),
      );
      onDone();
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("server_settings.quality_profiles_save_error"),
      );
    } finally {
      setPending(null);
    }
  };

  return (
    <View
      testID='quality-presets'
      style={{
        borderRadius: radius.lg,
        backgroundColor: color.bg["1"],
        padding: 16,
        marginBottom: 12,
      }}
    >
      <Text weight='semibold' style={{ marginBottom: 4 }}>
        {t("server_settings.quality_presets_title")}
      </Text>
      <Text variant='caption' tone='secondary' style={{ marginBottom: 12 }}>
        {t("server_settings.quality_presets_detail")}
      </Text>

      {names.length === 0 ? (
        <Text variant='caption' tone='secondary'>
          {vocabulary.isLoading
            ? t("server_settings.quality_profiles_reading_vocabulary")
            : t("server_settings.quality_profiles_no_vocabulary")}
        </Text>
      ) : (
        <ListGroup>
          {PRESETS.map((preset) => {
            const resolved = resolvePreset(preset, names);
            const present = isPresetPresent(preset, existing);
            return (
              <ListItem
                key={preset.key}
                title={t(`server_settings.quality_preset_${preset.key}_title`)}
                subtitle={
                  resolved
                    ? t(`server_settings.quality_preset_${preset.key}_detail`)
                    : t("server_settings.quality_presets_unavailable")
                }
                value={
                  present
                    ? t("server_settings.quality_presets_already")
                    : undefined
                }
                showArrow={!present && !!resolved}
                onPress={
                  present || !resolved || pending !== null
                    ? undefined
                    : () => void add(preset)
                }
              />
            );
          })}
        </ListGroup>
      )}
    </View>
  );
}

function describe(
  t: ReturnType<typeof useTranslation>["t"],
  p: QualityProfileView,
): string {
  const allowed = (p.Items ?? []).filter((i) => i.Allowed).length;
  const bits = [
    t("server_settings.quality_profiles_groups_allowed", { count: allowed }),
    p.Cutoff
      ? t("server_settings.quality_profiles_cutoff", { cutoff: p.Cutoff })
      : null,
    p.UpgradeAllowed
      ? t("server_settings.quality_profiles_upgrades_on")
      : t("server_settings.quality_profiles_upgrades_off"),
    (p.Apps ?? []).map((app) => arrAppLabel(t, app)).join(" + "),
  ];
  if (p.InSync === false && (p.Apps ?? []).length > 1) {
    bits.push(t("server_settings.quality_profiles_apps_disagree"));
  }
  return bits.filter(Boolean).join(" • ");
}

/**
 * The editor itself.
 *
 * Names, not ids, throughout — a profile's identity across two apps is its name,
 * and the ids differ per app. The checkbox list is the *shared* vocabulary by
 * default with a switch to see each app's whole list, because a profile built
 * only from names Sonarr also knows is the one that behaves the same in both.
 */
function ProfileEditor({
  initial,
  onDone,
}: {
  initial: QualityProfileView | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { color, accent } = useTheme();
  const vocabulary = useQualityVocabulary();
  const save = useSaveQualityProfile();
  const isNew = initial === null;

  const name = initial?.Name ?? "";
  const [upgrade, setUpgrade] = useState(initial?.UpgradeAllowed ?? true);
  const [cutoff, setCutoff] = useState(initial?.Cutoff ?? "");
  const [showAll, setShowAll] = useState(false);
  const [allowed, setAllowed] = useState<string[]>(() =>
    (initial?.Items ?? []).filter((i) => i.Allowed).map((i) => i.Name ?? ""),
  );

  const names = useMemo(() => {
    if (!vocabulary.data) return [];
    if (!showAll) return vocabulary.data.Shared ?? [];
    // The union, in the first app's order, so the list stays best-first.
    const seen = new Set<string>();
    const out: string[] = [];
    for (const list of Object.values(vocabulary.data.Apps ?? {})) {
      for (const n of list ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          out.push(n);
        }
      }
    }
    return out;
  }, [vocabulary.data, showAll]);

  const toggle = (quality: string) =>
    setAllowed((current) =>
      current.includes(quality)
        ? current.filter((q) => q !== quality)
        : [...current, quality],
    );

  const submit = async () => {
    if (allowed.length === 0) {
      toast.error(t("server_settings.quality_profiles_allow_one_required"));
      return;
    }
    try {
      const result = await save.mutateAsync({
        isNew,
        profile: {
          Name: name.trim(),
          UpgradeAllowed: upgrade,
          Cutoff: cutoff || allowed[allowed.length - 1],
          Items: allowed.map((q) => ({ Name: q, Allowed: true })),
        },
      });
      const unsupported = Object.entries(result?.Profile?.Unsupported ?? {})
        .filter(([, list]) => (list ?? []).length > 0)
        .map(([app, list]) =>
          t("server_settings.quality_profiles_app_has_no", {
            app: arrAppLabel(t, app),
            list: (list ?? []).join(", "),
          }),
        );
      toast.success(
        [result?.Detail?.join("; "), ...unsupported]
          .filter(Boolean)
          .join(" — "),
      );
      onDone();
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("server_settings.quality_profiles_save_error"),
      );
    }
  };

  return (
    <View
      style={{
        borderRadius: radius.lg,
        backgroundColor: color.bg["1"],
        padding: 16,
        marginBottom: 12,
      }}
    >
      <Text weight='semibold' style={{ marginBottom: 4 }}>
        {name}
      </Text>
      <Text variant='caption' tone='secondary' style={{ marginBottom: 12 }}>
        {t("server_settings.quality_profiles_rename_hint")}
      </Text>

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <Text style={{ flex: 1, marginRight: 12 }}>
          {t("server_settings.quality_profiles_upgrade_title")}
        </Text>
        <SettingSwitch value={upgrade} onValueChange={setUpgrade} />
      </View>

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 4,
        }}
      >
        <Text weight='semibold'>
          {t("server_settings.quality_profiles_allowed_qualities_title")}
        </Text>
        <Pressable onPress={() => setShowAll((v) => !v)}>
          <Text variant='caption' tone='accent'>
            {showAll
              ? t("server_settings.quality_profiles_shared_only_action")
              : t("server_settings.quality_profiles_show_every_action")}
          </Text>
        </Pressable>
      </View>
      <Text variant='caption' tone='secondary' style={{ marginBottom: 8 }}>
        {showAll
          ? t("server_settings.quality_profiles_showing_every_detail")
          : t("server_settings.quality_profiles_showing_shared_detail")}
      </Text>

      {/*
        The shortcut, and for most readers the only control here: "add 4K" rather than five
        separate pills whose names differ only in how the file was made. Toggling a group adds or
        removes all of it at once; the individual formats below stay for somebody who wants to
        exclude one of them.
      */}
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 12,
        }}
      >
        {availableGroups(names).map((group) => {
          const members = inGroup(names, group);
          const on = members.every((q) => allowed.includes(q));
          return (
            <ChoicePill
              key={group}
              label={t(`server_settings.quality_group_${group}`)}
              selected={on}
              onPress={() =>
                setAllowed((current) =>
                  on
                    ? current.filter((q) => !members.includes(q))
                    : [
                        ...current,
                        ...members.filter((q) => !current.includes(q)),
                      ],
                )
              }
            />
          );
        })}
      </View>

      <Text variant='caption' tone='secondary' style={{ marginBottom: 8 }}>
        {t("server_settings.quality_profiles_individual_detail")}
      </Text>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 12,
        }}
      >
        {names.map((q) => (
          <Pressable
            key={q}
            onPress={() => toggle(q)}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: radius.pill,
              backgroundColor: allowed.includes(q)
                ? accent[500]
                : color.bg["3"],
            }}
          >
            <Text
              variant='caption'
              weight='semibold'
              tone={allowed.includes(q) ? "onAccent" : "secondary"}
            >
              {q}
            </Text>
          </Pressable>
        ))}
        {names.length === 0 && (
          <Text variant='caption' tone='secondary'>
            {vocabulary.isLoading
              ? t("server_settings.quality_profiles_reading_vocabulary")
              : t("server_settings.quality_profiles_no_vocabulary")}
          </Text>
        )}
      </View>

      <Text weight='semibold' style={{ marginBottom: 4 }}>
        {t("server_settings.quality_profiles_upgrade_until_title")}
      </Text>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 12,
        }}
      >
        {allowed.map((q) => (
          <Pressable
            key={q}
            onPress={() => setCutoff(q)}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: radius.pill,
              backgroundColor: cutoff === q ? accent[500] : color.bg["3"],
            }}
          >
            <Text
              variant='caption'
              weight='semibold'
              tone={cutoff === q ? "onAccent" : "secondary"}
            >
              {q}
            </Text>
          </Pressable>
        ))}
        {allowed.length === 0 && (
          <Text variant='caption' tone='secondary'>
            {t("server_settings.quality_profiles_pick_qualities_first")}
          </Text>
        )}
      </View>

      <Button
        variant='primary'
        loading={save.isPending}
        onPress={() => void submit()}
      >
        {save.isPending
          ? t("server_settings.quality_profiles_saving_action")
          : isNew
            ? t("server_settings.quality_profiles_create_action")
            : t("server_settings.quality_profiles_save_action")}
      </Button>
    </View>
  );
}
