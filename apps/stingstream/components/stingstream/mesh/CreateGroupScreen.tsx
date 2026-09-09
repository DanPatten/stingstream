import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { FormError } from "@/components/common/FormError";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { useInviteLibraries } from "@/lib/stingstream/invites";
import {
  useCreateMeshGroup,
  useSetSharedLibraries,
} from "@/lib/stingstream/mesh";
import { useMesh } from "@/providers/MeshProvider";
import { LibraryPicker } from "../shared/LibraryPicker";
import { useChosenLibraries } from "../shared/useChosenLibraries";
import { FormCard } from "./FormCard";
import { InviteCard } from "./InviteCard";

/**
 * Invite another server owner: what to call them, what they get, then the link.
 *
 * Two stages rather than a modal that closes, because a link with nobody on the other end does
 * nothing at all and the invite is the only thing that changes that.
 *
 * **Two questions, and neither is about networking.** This screen has been through a coordinator
 * picker, a free-text address field and a Public/Private radio, every one of which asked somebody
 * to make a decision they had no basis for. What is left is a name for the person and the
 * libraries they get — the same pair a person invite asks, with the same control, because it is
 * the same question asked of a different audience.
 *
 * The libraries are chosen **here** rather than afterwards for a reason worth keeping: a link
 * publishes nothing until somebody picks, so a create screen that did not ask would hand out an
 * invite to an empty share and leave the owner to discover why later.
 */
export function CreateGroupScreen() {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const create = useCreateMeshGroup();
  const libraries = useInviteLibraries();
  const share = useSetSharedLibraries();
  const mesh = useMesh();

  const available = libraries.data ?? [];
  // Every library ticked to begin with; unticking is the edit. See the hook for why that is a UI
  // default and leaves the server's own share-nothing default alone.
  const { chosen, toggle } = useChosenLibraries(available);

  // Both halves, because an invite to a share of nothing is worse than no invite: it looks like it
  // worked and produces an empty library on the other server.
  const ready = name.trim().length > 0 && chosen.length > 0;

  const onCreate = async () => {
    setError(null);
    try {
      const group = await create.mutateAsync({ name: name.trim() });
      // Before the invite is shown, so the link is never handed out ahead of the choice it
      // depends on.
      await share.mutateAsync({ group: group.group, libraries: chosen });
      setCreated({ id: group.group, name: group.name });
      // The phone joins the new group as a light member straight away, so the very first thing
      // played from it goes peer to peer rather than through the server.
      await mesh.syncGroups();
      toast.success(t("sharing.create_success", { name: group.name }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <FormCard>
      {created ? (
        <View>
          <Text variant='title' weight='semibold'>
            {t("sharing.create_live_title", { name: created.name })}
          </Text>
          <Text
            variant='caption'
            tone='secondary'
            style={{ marginTop: 4, marginBottom: 16 }}
          >
            {t("sharing.create_live_detail")}
          </Text>
          <InviteCard group={created.id} groupName={created.name} />
        </View>
      ) : (
        <View>
          <Text variant='title' weight='semibold'>
            {t("sharing.create_title")}
          </Text>
          <Text
            variant='caption'
            tone='secondary'
            style={{ marginTop: 4, marginBottom: 20 }}
          >
            {t("sharing.create_detail")}
          </Text>

          <Input
            placeholder={t("sharing.create_name_placeholder")}
            autoCapitalize='words'
            autoCorrect={false}
            value={name}
            editable={!create.isPending}
            onChangeText={setName}
            // A TV remote has no soft keyboard shortcut for "done", so submitting from the field
            // itself is what saves a trip down to the button.
            returnKeyType='done'
            onSubmitEditing={() =>
              ready && !create.isPending && void onCreate()
            }
          />

          <View style={{ height: 20 }} />

          <Text variant='caption' tone='secondary' weight='medium'>
            {t("sharing.link_libraries_title")}
          </Text>
          <Text variant='caption' tone='tertiary' style={{ marginBottom: 8 }}>
            {t("sharing.link_libraries_hint")}
          </Text>
          <LibraryPicker
            available={available}
            selected={chosen}
            onToggle={toggle}
            loading={libraries.isPending}
            disabled={create.isPending || share.isPending}
          />

          <FormError message={error} />

          <View style={{ height: 20 }} />

          <Button
            onPress={onCreate}
            disabled={!ready}
            loading={create.isPending || share.isPending}
            hasTVPreferredFocus={Platform.isTV && ready}
          >
            {t("sharing.create_submit")}
          </Button>
        </View>
      )}
    </FormCard>
  );
}
