import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { FormError } from "@/components/common/FormError";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { useCreateMeshGroup } from "@/lib/stingstream/mesh";
import { useMesh } from "@/providers/MeshProvider";
import {
  type CoordinatorChoice,
  CoordinatorPicker,
  coordinatorChoiceReady,
  coordinatorChoiceValue,
} from "./CoordinatorPicker";
import { FormCard } from "./FormCard";
import { InviteCard } from "./InviteCard";

/**
 * Create a group on the server, then show the invite so it can be handed on straight away.
 *
 * Creating is deliberately a two-stage screen rather than a modal that closes: a group with no
 * other members does nothing at all, and the invite is the only thing that changes that.
 */
export function CreateGroupScreen() {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [coordinator, setCoordinator] = useState<CoordinatorChoice>({
    kind: "default",
  });
  const [created, setCreated] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const create = useCreateMeshGroup();
  const mesh = useMesh();

  const ready = name.trim().length > 0 && coordinatorChoiceReady(coordinator);

  const onCreate = async () => {
    setError(null);
    try {
      const group = await create.mutateAsync({
        name: name.trim(),
        coordinator: coordinatorChoiceValue(coordinator),
      });
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

          <View style={{ height: 16 }} />

          <CoordinatorPicker
            value={coordinator}
            onChange={setCoordinator}
            disabled={create.isPending}
          />

          <FormError message={error} />

          <View style={{ height: 20 }} />

          <Button
            onPress={onCreate}
            disabled={!ready}
            loading={create.isPending}
            hasTVPreferredFocus={Platform.isTV && ready}
          >
            {t("sharing.create_submit")}
          </Button>
        </View>
      )}
    </FormCard>
  );
}
