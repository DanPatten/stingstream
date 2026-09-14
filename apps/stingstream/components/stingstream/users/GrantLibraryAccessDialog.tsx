import type { UserDto } from "@jellyfin/sdk/lib/generated-client/models";
import { useAtomValue } from "jotai";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Checkbox } from "@/components/common/Checkbox";
import { Dialog } from "@/components/common/Dialog";
import { FormError } from "@/components/common/FormError";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { radius, space } from "@/constants/theme";
import { usePressableStates } from "@/hooks/usePressableStates";
import { useTheme } from "@/hooks/useTheme";
import { useInviteLibraries } from "@/lib/stingstream/invites";
import {
  useServerUsers,
  useSetUserPolicy,
} from "@/lib/stingstream/serverUsers";
import { apiAtom } from "@/providers/JellyfinProvider";
import { InvitePerson } from "../invites/InvitePerson";
import { UserAvatar } from "./UserAvatar";
import { hasLibrary, policyWithLibrary } from "./userAccess";

/**
 * Who can watch one library, from that library's own page.
 *
 * Plex's "Grant Library Access", as Dan asked for it: a search box, the people on this server with
 * a tick each, Cancel and Continue, plus an Invite button that opens the invite form with just this
 * library ticked. Administrators see everything whatever their policy says, so their tick is shown
 * and cannot be changed.
 *
 * Nothing is written until Continue, and then only for the people whose tick actually moved: the
 * policy endpoint replaces the whole policy, so an untouched account is never re-sent.
 */
export function GrantLibraryAccessDialog({
  visible,
  libraryId,
  libraryName,
  onClose,
}: {
  visible: boolean;
  /** The media server's id for the library. */
  libraryId: string;
  libraryName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [inviting, setInviting] = useState(false);

  return (
    <>
      <Dialog
        visible={visible && !inviting}
        onClose={onClose}
        title={t("libraries.grant_title")}
        description={t("libraries.grant_detail", { name: libraryName })}
      >
        {visible ? (
          <GrantBody
            libraryId={libraryId}
            onClose={onClose}
            onInvite={() => setInviting(true)}
          />
        ) : null}
      </Dialog>
      <InvitePerson
        visible={visible && inviting}
        onClose={() => setInviting(false)}
        initialLibraries={[libraryId]}
      />
    </>
  );
}

function GrantBody({
  libraryId,
  onClose,
  onInvite,
}: {
  libraryId: string;
  onClose: () => void;
  onInvite: () => void;
}) {
  const { t } = useTranslation();
  const api = useAtomValue(apiAtom);
  const users = useServerUsers();
  const available = useInviteLibraries();
  const setPolicy = useSetUserPolicy();

  const [filter, setFilter] = useState("");
  /** Only the ticks somebody changed. Everything else reads from the stored policy. */
  const [changes, setChanges] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const people = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (users.data ?? [])
      .filter(
        (user) => !needle || (user.Name ?? "").toLowerCase().includes(needle),
      )
      .sort((a, b) => (a.Name ?? "").localeCompare(b.Name ?? ""));
  }, [users.data, filter]);

  const ticked = (user: UserDto) =>
    user.Id && user.Id in changes
      ? changes[user.Id]
      : hasLibrary(user.Policy, libraryId);

  const dirty = (users.data ?? []).filter(
    (user) =>
      user.Id &&
      !user.Policy?.IsAdministrator &&
      user.Id in changes &&
      changes[user.Id] !== hasLibrary(user.Policy, libraryId),
  );

  const save = async () => {
    if (dirty.length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      for (const user of dirty) {
        await setPolicy.mutateAsync({
          userId: user.Id!,
          policy: policyWithLibrary(
            user.Policy!,
            libraryId,
            changes[user.Id!],
            available.data ?? [],
          ),
        });
      }
      toast.success(t("libraries.grant_saved"));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("libraries.save_error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={{ gap: space["3"] }}>
      <Input
        testID='grant-filter'
        icon='search'
        placeholder={t("libraries.grant_filter")}
        value={filter}
        onChangeText={setFilter}
        autoCapitalize='none'
        autoCorrect={false}
      />

      <View style={{ gap: 2 }}>
        {people.length === 0 && !users.isLoading ? (
          <Text variant='body' tone='secondary'>
            {t("libraries.grant_none")}
          </Text>
        ) : (
          people.map((user) => (
            <PersonRow
              key={user.Id}
              user={user}
              serverAddress={api?.basePath}
              checked={ticked(user)}
              locked={Boolean(user.Policy?.IsAdministrator)}
              disabled={saving}
              onToggle={() =>
                setChanges((current) => ({
                  ...current,
                  [user.Id!]: !ticked(user),
                }))
              }
            />
          ))
        )}
      </View>

      <FormError message={error} />

      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: space["2"],
          marginTop: space["2"],
        }}
      >
        <Button
          testID='grant-invite'
          variant='secondary'
          size='md'
          icon='invite'
          onPress={onInvite}
        >
          {t("libraries.grant_invite")}
        </Button>
        <View style={{ flex: 1 }} />
        <Button variant='ghost' size='md' onPress={onClose}>
          {t("libraries.cancel")}
        </Button>
        <Button
          testID='grant-continue'
          variant='primary'
          size='md'
          loading={saving}
          disabled={saving || !available.data}
          onPress={() => void save()}
        >
          {t("libraries.grant_continue")}
        </Button>
      </View>
    </View>
  );
}

function PersonRow({
  user,
  serverAddress,
  checked,
  locked,
  disabled,
  onToggle,
}: {
  user: UserDto;
  serverAddress?: string;
  checked: boolean;
  locked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const { color } = useTheme();
  const inert = locked || disabled;
  const states = usePressableStates({ disabled: inert });

  return (
    <Pressable
      testID='grant-person'
      accessibilityRole='checkbox'
      accessibilityState={{ checked, disabled: inert }}
      aria-checked={checked}
      disabled={inert}
      onPress={onToggle}
      {...states.handlers}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: space["3"],
          paddingHorizontal: space["3"],
          paddingVertical: space["2"],
          borderRadius: radius.md,
          backgroundColor:
            states.hovered || states.pressed ? color.bg["3"] : color.bg["2"],
        },
        states.webStyle,
      ]}
    >
      <UserAvatar serverAddress={serverAddress} user={user} size={32} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant='body' numberOfLines={1}>
          {user.Name}
        </Text>
        {locked ? (
          <Text variant='caption' tone='tertiary'>
            {t("libraries.grant_administrator")}
          </Text>
        ) : null}
      </View>
      <Checkbox checked={checked} disabled={inert} />
    </Pressable>
  );
}
