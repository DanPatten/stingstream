import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Input } from "@/components/common/Input";
import { SettingSwitch } from "@/components/common/SettingSwitch";
import {
  SheetBackdrop,
  type SheetBackdropProps,
  SheetModal,
  type SheetModalRef,
  SheetScrollView,
} from "@/components/common/Sheet";
import { Text } from "@/components/common/Text";
import { FilterChip } from "@/components/filters/FilterChip";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { useTheme } from "@/hooks/useTheme";
import {
  type QualityProfileView,
  useDeleteQualityProfile,
  useQualityProfiles,
  useResetQualityProfile,
  useSaveQualityProfile,
} from "@/lib/stingstream/hooks";
import { confirmAction, confirmDestructive } from "../shared/confirm";
import { ScreenHeaderRow } from "../shared/ScreenHeaderRow";
import { EmptyState, QueryState } from "../shared/ScreenState";
import { SaveStatus } from "./fields";
import {
  draftOf,
  NEW_PROFILE_DRAFT,
  type ProfileDraft,
  TIERS,
  toggleTier,
} from "./qualityTiers";
import { useAutosave } from "./useAutosave";

type TFunction = ReturnType<typeof useTranslation>["t"];

const errorText = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

/**
 * Server settings → Quality profiles.
 *
 * One list, one sheet. A node starts with Any, High, Medium and Low (`BuiltInQualityProfiles` on
 * the server); tapping one opens its four picture sizes, where upgrading stops, and what can be done
 * with it: made the default, reset, or, for a profile somebody added, deleted. Dan, 2026-09-13:
 * *"Make the interface super simple, start with Any, High, Med, and Low quality as defaults. Users
 * can modify these, reset to default or add their own."*
 *
 * The screen it replaces offered presets, format groups, twenty-odd raw format names and a separate
 * default picker, and read an empty list whenever the server could not be reached.
 */
export function QualityProfilesSection({
  value,
  onSave,
  saving,
}: {
  /** The shared settings' default-profile name. */
  value: string;
  onSave: (next: string) => Promise<void>;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const profiles = useQualityProfiles();
  // `null` name is New; an object at all means the sheet is open.
  const [open, setOpen] = useState<{ name: string | null } | null>(null);
  const [generation, setGeneration] = useState(0);

  const {
    draft: defaultName,
    set: setDefault,
    saving: sendingDefault,
  } = useAutosave({
    value,
    save: async (next) => {
      try {
        await onSave(next);
        toast.success(
          t("server_settings.quality_profiles_default_saved_toast"),
        );
      } catch (err) {
        toast.error(errorText(err, t("server_settings.save_error")));
      }
    },
  });

  const list = profiles.data ?? [];
  const isDefault = (p: QualityProfileView) =>
    defaultName ? p.Name === defaultName : !!p.IsDefault;
  const editing =
    open?.name != null ? list.find((p) => p.Name === open.name) : undefined;

  return (
    <View>
      <ScreenHeaderRow
        title={t("server_settings.quality_profiles_title")}
        accessory={
          <Button
            variant='secondary'
            size='sm'
            icon='add'
            onPress={() => setOpen({ name: null })}
          >
            {t("server_settings.quality_profiles_new_action")}
          </Button>
        }
      />

      <QueryState
        isLoading={profiles.isLoading}
        error={profiles.error}
        onRetry={profiles.refetch}
      >
        {list.length === 0 ? (
          <EmptyState
            title={t("server_settings.quality_profiles_empty_title")}
            detail={t("server_settings.quality_profiles_empty_detail")}
          />
        ) : (
          <ListGroup>
            {list.map((p) => (
              <ListItem
                key={p.Name}
                title={p.Name ?? ""}
                subtitle={describeTiers(t, p)}
                value={
                  isDefault(p)
                    ? t("server_settings.quality_profiles_default_value")
                    : undefined
                }
                showArrow
                onPress={() => setOpen({ name: p.Name ?? "" })}
              />
            ))}
          </ListGroup>
        )}
      </QueryState>
      <SaveStatus saving={saving || sendingDefault} />

      <ProfileSheet open={open !== null} onClose={() => setOpen(null)}>
        {open?.name === null ? (
          <NewProfileForm onDone={() => setOpen(null)} />
        ) : editing ? (
          <ProfileEditor
            key={`${editing.Name}:${generation}`}
            profile={editing}
            isDefault={isDefault(editing)}
            onSetDefault={() =>
              setDefault(() => editing.Name ?? "", { now: true })
            }
            onReset={async () => {
              // Re-seed the editor from what the server now holds, not from the list it had.
              await profiles.refetch();
              setGeneration((g) => g + 1);
            }}
            onDeleted={() => setOpen(null)}
          />
        ) : null}
      </ProfileSheet>
    </View>
  );
}

/** "720p, 1080p", or a plain word for a profile made of qualities in no tier. */
function describeTiers(t: TFunction, p: QualityProfileView): string {
  const tiers = draftOf(p).tiers;
  return tiers.length > 0
    ? tiers.map((tier) => t(`server_settings.quality_tier_${tier}`)).join(", ")
    : t("server_settings.quality_profiles_no_tiers");
}

function ProfileSheet({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { color } = useTheme();
  const ref = useRef<SheetModalRef>(null);

  useEffect(() => {
    if (open) ref.current?.present();
    else ref.current?.dismiss();
  }, [open]);

  const renderBackdrop = useCallback(
    (props: SheetBackdropProps) => (
      <SheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} />
    ),
    [],
  );

  return (
    <SheetModal
      ref={ref}
      enableDynamicSizing
      enablePanDownToClose
      onDismiss={onClose}
      backdropComponent={renderBackdrop}
      backgroundStyle={{ backgroundColor: color.bg["1"] }}
      handleIndicatorStyle={{ backgroundColor: color.border.strong }}
      webMaxWidth={480}
    >
      <SheetScrollView contentContainerStyle={{ padding: 20, gap: 20 }}>
        {children}
      </SheetScrollView>
    </SheetModal>
  );
}

/** An existing profile. Every change is sent the moment it is made. */
function ProfileEditor({
  profile,
  isDefault,
  onSetDefault,
  onReset,
  onDeleted,
}: {
  profile: QualityProfileView;
  isDefault: boolean;
  onSetDefault: () => void;
  onReset: () => Promise<void>;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const save = useSaveQualityProfile();
  const reset = useResetQualityProfile();
  const remove = useDeleteQualityProfile();
  const name = profile.Name ?? "";

  const { draft, set, saving } = useAutosave<ProfileDraft>({
    value: draftOf(profile),
    save: async (next) => {
      try {
        await save.mutateAsync({
          isNew: false,
          profile: {
            Name: name,
            Tiers: next.tiers,
            CutoffTier: next.cutoff ?? undefined,
            UpgradeAllowed: next.upgrade,
          },
        });
        toast.success(t("server_settings.quality_profiles_saved_toast"));
      } catch (err) {
        toast.error(
          errorText(err, t("server_settings.quality_profiles_save_error")),
        );
      }
    },
  });

  const doReset = async () => {
    const ok = await confirmAction(
      t("server_settings.quality_profiles_reset_confirm_title", { name }),
      t("server_settings.quality_profiles_reset_confirm_message"),
      t("server_settings.quality_profiles_reset_action"),
    );
    if (!ok) return;
    try {
      await reset.mutateAsync(name);
      toast.success(t("server_settings.quality_profiles_reset_toast"));
      await onReset();
    } catch (err) {
      toast.error(
        errorText(err, t("server_settings.quality_profiles_reset_error")),
      );
    }
  };

  const doDelete = async () => {
    const ok = await confirmDestructive(
      t("server_settings.quality_profiles_delete_confirm_title", { name }),
      t("server_settings.quality_profiles_delete_confirm_message"),
    );
    if (!ok) return;
    try {
      await remove.mutateAsync(name);
      toast.success(t("server_settings.quality_profiles_deleted_toast"));
      onDeleted();
    } catch (err) {
      toast.error(
        errorText(err, t("server_settings.quality_profiles_delete_error")),
      );
    }
  };

  if (!draft) return null;

  return (
    <>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Text weight='semibold'>{name}</Text>
        {isDefault ? (
          <Text variant='caption' tone='secondary'>
            {t("server_settings.quality_profiles_default_value")}
          </Text>
        ) : null}
      </View>

      <TierFields
        draft={draft}
        onChange={(next) => set(() => next, { now: true })}
      />
      <SaveStatus saving={saving} />

      <ListGroup>
        {!isDefault ? (
          <ListItem
            title={t("server_settings.quality_profiles_set_default_action")}
            textColor='blue'
            onPress={onSetDefault}
          />
        ) : null}
        {profile.IsBuiltIn ? (
          <ListItem
            title={t("server_settings.quality_profiles_reset_action")}
            textColor='blue'
            disabled={reset.isPending}
            onPress={() => void doReset()}
          />
        ) : (
          <ListItem
            title={t("server_settings.quality_profiles_delete_action")}
            textColor='red'
            disabled={remove.isPending}
            onPress={() => void doDelete()}
          />
        )}
      </ListGroup>
    </>
  );
}

/** A new profile. The one place on this screen with a button, because creating is the decision. */
function NewProfileForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const save = useSaveQualityProfile();
  const [name, setName] = useState("");
  const [draft, setDraft] = useState<ProfileDraft>(NEW_PROFILE_DRAFT);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t("server_settings.quality_profiles_name_required"));
      return;
    }
    try {
      await save.mutateAsync({
        isNew: true,
        profile: {
          Name: trimmed,
          Tiers: draft.tiers,
          CutoffTier: draft.cutoff ?? undefined,
          UpgradeAllowed: draft.upgrade,
        },
      });
      toast.success(t("server_settings.quality_profiles_saved_toast"));
      onDone();
    } catch (err) {
      setError(
        errorText(err, t("server_settings.quality_profiles_save_error")),
      );
    }
  };

  return (
    <>
      <Text weight='semibold'>
        {t("server_settings.quality_profiles_new_title")}
      </Text>
      <Input
        value={name}
        onChangeText={(next) => {
          setName(next);
          setError(null);
        }}
        placeholder={t("server_settings.quality_profiles_name_placeholder")}
        autoFocus
        onSubmitEditing={() => void submit()}
        error={error}
      />
      <TierFields draft={draft} onChange={setDraft} />
      <Button
        variant='primary'
        loading={save.isPending}
        onPress={() => void submit()}
      >
        {t("server_settings.quality_profiles_create_action")}
      </Button>
    </>
  );
}

/** Picture sizes, where upgrading stops, and whether it upgrades at all. */
function TierFields({
  draft,
  onChange,
}: {
  draft: ProfileDraft;
  onChange: (next: ProfileDraft) => void;
}) {
  const { t } = useTranslation();
  const row = { flexDirection: "row", flexWrap: "wrap", gap: 8 } as const;

  return (
    <>
      <View style={{ gap: 8 }}>
        <Text variant='caption' tone='secondary' weight='semibold'>
          {t("server_settings.quality_profiles_quality_title")}
        </Text>
        <View style={row}>
          {TIERS.map((tier) => {
            const active = draft.tiers.includes(tier);
            return (
              <FilterChip
                key={tier}
                label={t(`server_settings.quality_tier_${tier}`)}
                active={active}
                disabled={active && draft.tiers.length === 1}
                onPress={() => onChange(toggleTier(draft, tier))}
              />
            );
          })}
        </View>
      </View>

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Text style={{ flex: 1 }}>
          {t("server_settings.quality_profiles_upgrade_title")}
        </Text>
        <SettingSwitch
          value={draft.upgrade}
          onValueChange={(upgrade) => onChange({ ...draft, upgrade })}
        />
      </View>

      {draft.upgrade && draft.tiers.length > 1 ? (
        <View style={{ gap: 8 }}>
          <Text variant='caption' tone='secondary' weight='semibold'>
            {t("server_settings.quality_profiles_upgrade_until_title")}
          </Text>
          <View style={row}>
            {draft.tiers.map((tier) => (
              <FilterChip
                key={tier}
                label={t(`server_settings.quality_tier_${tier}`)}
                active={draft.cutoff === tier}
                onPress={() => onChange({ ...draft, cutoff: tier })}
              />
            ))}
          </View>
        </View>
      ) : null}
    </>
  );
}
