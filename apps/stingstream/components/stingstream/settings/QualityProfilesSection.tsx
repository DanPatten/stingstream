import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Input } from "@/components/common/Input";
import { SettingSwitch } from "@/components/common/SettingSwitch";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { radius, tokens } from "@/constants/theme";
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
import { SaveBar, TextFieldRow } from "./fields";

/**
 * Server settings → Quality profiles. Gap 4 closed.
 *
 * A profile is one thing with one name, written into **both** Radarr and Sonarr
 * — that is the Omniarr premise, and it is why there is no app picker here. What
 * the two apps do not share is the quality vocabulary itself, so the editor
 * offers the *shared* names by default and says plainly when a profile is asking
 * for something one app does not have (`Unsupported`) or when the two apps have
 * drifted apart (`InSync`). Both are real states somebody needs to see, not
 * errors to hide.
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
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState<QualityProfileView | null>(null);
  const [creating, setCreating] = useState(false);
  const profiles = useQualityProfiles();
  const remove = useDeleteQualityProfile();
  const dirty = draft !== value;

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
        <ProfileEditor initial={null} onDone={() => setCreating(false)} />
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
                      backgroundColor: tokens.color.bg["2"],
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

      <ListGroup>
        <TextFieldRow
          title={t("server_settings.quality_profiles_default_name_title")}
          subtitle={t("server_settings.quality_profiles_default_name_detail")}
          value={draft}
          onChangeText={setDraft}
        />
      </ListGroup>
      <SaveBar
        dirty={dirty}
        saving={saving}
        onDiscard={() => setDraft(value)}
        onSave={async () => {
          try {
            await onSave(draft);
            toast.success(
              t("server_settings.quality_profiles_default_saved_toast"),
            );
          } catch (err) {
            toast.error(
              err instanceof Error
                ? err.message
                : t("server_settings.save_error"),
            );
          }
        }}
      />
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
  const { accent } = useTheme();
  const vocabulary = useQualityVocabulary();
  const save = useSaveQualityProfile();
  const isNew = initial === null;

  const [name, setName] = useState(initial?.Name ?? "");
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
    if (!name.trim()) {
      toast.error(t("server_settings.quality_profiles_name_required"));
      return;
    }
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
        backgroundColor: tokens.color.bg["1"],
        padding: 16,
        marginBottom: 12,
      }}
    >
      <Input
        placeholder={t("server_settings.quality_profiles_name_placeholder")}
        value={name}
        editable={isNew}
        onChangeText={setName}
        style={{ marginBottom: 8 }}
      />
      {!isNew && (
        <Text variant='caption' tone='secondary' style={{ marginBottom: 8 }}>
          {t("server_settings.quality_profiles_rename_hint")}
        </Text>
      )}

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
                : tokens.color.bg["3"],
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
              backgroundColor:
                cutoff === q ? accent[500] : tokens.color.bg["3"],
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
