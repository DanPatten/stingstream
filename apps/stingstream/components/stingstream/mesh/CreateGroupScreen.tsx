import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { FormError } from "@/components/common/FormError";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import {
  useCreateMeshGroup,
  useMeshSharingSettings,
} from "@/lib/stingstream/mesh";
import { useMesh } from "@/providers/MeshProvider";
import { FormCard } from "./FormCard";
import { InviteCard } from "./InviteCard";

/**
 * Create a group, then show the invite so it can be handed on straight away.
 *
 * Two stages rather than a modal that closes: a group with no other members does nothing at all,
 * and the invite is the only thing that changes that.
 *
 * **One question, and it is the name.** This screen has been through a coordinator picker, a
 * free-text address field and a Public/Private radio, and every one of them asked the person
 * creating a group to make a networking decision they had no basis for. The server it uses is this
 * node's sharing server, which arrives already set; changing it is a settings job, under Advanced
 * on the Sharing screen, where somebody who wants it will go looking.
 */
export function CreateGroupScreen() {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const create = useCreateMeshGroup();
  const settings = useMeshSharingSettings();
  const mesh = useMesh();

  // Wait for the settings rather than racing them: creating with `coordinator: null` because the
  // query had not landed yet would make a group that is quietly server-less, and nothing on screen
  // would ever say so.
  const settled = settings.isSuccess || settings.isError;
  const ready = name.trim().length > 0 && settled;

  const onCreate = async () => {
    setError(null);
    try {
      const group = await create.mutateAsync({
        name: name.trim(),
        coordinator: settings.data?.coordinatorDefault ?? null,
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
