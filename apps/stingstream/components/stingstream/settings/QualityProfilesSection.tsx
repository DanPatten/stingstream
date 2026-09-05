import { useMemo, useState } from "react";
import { TextInput, TouchableOpacity, View } from "react-native";
import { toast } from "sonner-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { Colors } from "@/constants/Colors";
import {
  type QualityProfileView,
  useDeleteQualityProfile,
  useQualityProfiles,
  useQualityVocabulary,
  useSaveQualityProfile,
} from "@/lib/stingstream/hooks";
import { confirmDestructive } from "../shared/confirm";
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
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState<QualityProfileView | null>(null);
  const [creating, setCreating] = useState(false);
  const profiles = useQualityProfiles();
  const remove = useDeleteQualityProfile();
  const dirty = draft !== value;

  const del = async (name: string) => {
    const ok = await confirmDestructive(
      `Delete "${name}"?`,
      "The profile is removed from both Radarr and Sonarr. An app will refuse if any title is still using it.",
    );
    if (!ok) return;
    try {
      const result = await remove.mutateAsync(name);
      toast.success(result?.Detail?.join("; ") || "Deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete");
    }
  };

  return (
    <View>
      <View className='flex-row items-center justify-between mb-2'>
        <Text className='text-white text-lg font-semibold'>
          Quality profiles
        </Text>
        <TouchableOpacity
          onPress={() => {
            setEditing(null);
            setCreating((v) => !v);
          }}
        >
          <Text className='text-[#0584FE] font-semibold'>
            {creating ? "Cancel" : "+ New"}
          </Text>
        </TouchableOpacity>
      </View>

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
            title='No quality profiles'
            detail='Neither app has one, which normally means neither has finished starting. Press "+ New" to create one in both.'
          />
        ) : (
          <ListGroup>
            {(profiles.data ?? []).map((p) => (
              <View key={p.Name}>
                <ListItem
                  title={p.Name ?? ""}
                  subtitle={describe(p)}
                  subtitleColor={p.InSync === false ? "red" : "default"}
                  value={p.IsDefault ? "Default" : undefined}
                  showArrow
                  onPress={() =>
                    setEditing(editing?.Name === p.Name ? null : p)
                  }
                />
                {editing?.Name === p.Name && (
                  <View className='bg-neutral-800 px-4 py-3'>
                    <ProfileEditor
                      initial={p}
                      onDone={() => setEditing(null)}
                    />
                    <TouchableOpacity
                      className='mt-3'
                      onPress={() => void del(p.Name ?? "")}
                    >
                      <Text className='text-red-400'>Delete this profile</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            ))}
          </ListGroup>
        )}
      </QueryState>

      <View className='h-4' />

      <ListGroup>
        <TextFieldRow
          title='Default profile name'
          subtitle='Used when adding a title without picking one. Empty means "whatever the app lists first".'
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
            toast.success("Default quality profile saved");
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Could not save");
          }
        }}
      />
    </View>
  );
}

function describe(p: QualityProfileView): string {
  const allowed = (p.Items ?? []).filter((i) => i.Allowed).length;
  const bits = [
    `${allowed} quality group(s) allowed`,
    p.Cutoff ? `cutoff ${p.Cutoff}` : null,
    p.UpgradeAllowed ? "upgrades on" : "upgrades off",
    (p.Apps ?? []).join(" + "),
  ];
  if (p.InSync === false && (p.Apps ?? []).length > 1) {
    bits.push("the two apps disagree");
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
      toast.error("A profile needs a name");
      return;
    }
    if (allowed.length === 0) {
      toast.error("Allow at least one quality");
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
        .map(([app, list]) => `${app} has no ${(list ?? []).join(", ")}`);
      toast.success(
        [result?.Detail?.join("; "), ...unsupported]
          .filter(Boolean)
          .join(" — "),
      );
      onDone();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not save the profile",
      );
    }
  };

  return (
    <View className='rounded-xl bg-neutral-900 p-4 mb-3'>
      <TextInput
        placeholder='Profile name, e.g. 1080p'
        placeholderTextColor='#5A5960'
        value={name}
        editable={isNew}
        onChangeText={setName}
        className='bg-neutral-800 text-white rounded-lg px-3 py-2 mb-2'
      />
      {!isNew && (
        <Text className='text-[#9899A1] text-xs mb-2'>
          The name is the profile's identity in both apps, so it cannot be
          renamed here — a rename that succeeded in one app and failed in the
          other would leave two half-profiles. Create the new one and delete
          this.
        </Text>
      )}

      <TouchableOpacity
        onPress={() => setUpgrade((v) => !v)}
        className='flex-row items-center mb-3'
      >
        <View
          className='w-5 h-5 rounded mr-2 items-center justify-center'
          style={{ backgroundColor: upgrade ? Colors.primary : "#1f1f1f" }}
        >
          {upgrade && <Text className='text-white text-xs'>{"✓"}</Text>}
        </View>
        <Text className='text-white'>
          Upgrade an existing file when a better release appears
        </Text>
      </TouchableOpacity>

      <View className='flex-row items-center justify-between mb-2'>
        <Text className='text-white font-semibold'>Allowed qualities</Text>
        <TouchableOpacity onPress={() => setShowAll((v) => !v)}>
          <Text className='text-[#0584FE] text-xs'>
            {showAll ? "Shared only" : "Show every quality"}
          </Text>
        </TouchableOpacity>
      </View>
      <Text className='text-[#9899A1] text-xs mb-2'>
        {showAll
          ? "Every quality either app knows. One app will ignore what it does not have, and say so when you save."
          : "The qualities Radarr and Sonarr both understand — the safe set for a profile that governs films and series alike."}
      </Text>

      <View className='flex-row flex-wrap gap-2 mb-3'>
        {names.map((q) => (
          <TouchableOpacity
            key={q}
            onPress={() => toggle(q)}
            className='rounded-full px-3 py-1'
            style={{
              backgroundColor: allowed.includes(q) ? Colors.primary : "#2a2a2a",
            }}
          >
            <Text className='text-white text-xs'>{q}</Text>
          </TouchableOpacity>
        ))}
        {names.length === 0 && (
          <Text className='text-[#9899A1] text-xs'>
            {vocabulary.isLoading
              ? "Reading each app's quality list…"
              : "Neither app answered with a quality list."}
          </Text>
        )}
      </View>

      <Text className='text-white font-semibold mb-1'>Upgrade until</Text>
      <View className='flex-row flex-wrap gap-2 mb-3'>
        {allowed.map((q) => (
          <TouchableOpacity
            key={q}
            onPress={() => setCutoff(q)}
            className='rounded-full px-3 py-1'
            style={{ backgroundColor: cutoff === q ? "#9334E9" : "#2a2a2a" }}
          >
            <Text className='text-white text-xs'>{q}</Text>
          </TouchableOpacity>
        ))}
        {allowed.length === 0 && (
          <Text className='text-[#9899A1] text-xs'>
            Pick some qualities first — the cutoff has to be one of them.
          </Text>
        )}
      </View>

      <TouchableOpacity
        disabled={save.isPending}
        onPress={() => void submit()}
        className='rounded-lg py-2 items-center'
        style={{
          backgroundColor: Colors.primary,
          opacity: save.isPending ? 0.5 : 1,
        }}
      >
        <Text className='text-white font-semibold'>
          {save.isPending
            ? "Saving into both apps…"
            : isNew
              ? "Create in Radarr and Sonarr"
              : "Save to both apps"}
        </Text>
      </TouchableOpacity>
    </View>
  );
}
