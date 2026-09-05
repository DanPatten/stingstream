import { useState } from "react";
import { Platform, TextInput, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Text } from "@/components/common/Text";
import { useCreateMeshGroup } from "@/lib/stingstream/mesh";
import { useMesh } from "@/providers/MeshProvider";
import {
  type CoordinatorChoice,
  CoordinatorPicker,
  coordinatorChoiceReady,
  coordinatorChoiceValue,
} from "./CoordinatorPicker";
import { InviteCard } from "./InviteCard";

/**
 * Create a group on the home node, then show the invite so it can be handed on straight away.
 *
 * Creating is deliberately a two-stage screen rather than a modal that closes: a group with no
 * other members does nothing at all, and the invite is the only thing that changes that.
 */
export function CreateGroupScreen() {
  const [name, setName] = useState("");
  const [coordinator, setCoordinator] = useState<CoordinatorChoice>({
    kind: "default",
  });
  const [created, setCreated] = useState<{ id: string; name: string } | null>(
    null,
  );
  const create = useCreateMeshGroup();
  const mesh = useMesh();

  const ready = name.trim().length > 0 && coordinatorChoiceReady(coordinator);

  const onCreate = async () => {
    try {
      const group = await create.mutateAsync({
        name: name.trim(),
        coordinator: coordinatorChoiceValue(coordinator),
      });
      setCreated({ id: group.group, name: group.name });
      // The phone joins the new group as a light member straight away, so the very first thing
      // played from it goes peer to peer rather than through the home node.
      await mesh.syncGroups();
      toast.success(`Created ${group.name}`);
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  if (created) {
    return (
      <View>
        <Text className='text-white text-lg font-semibold mb-2'>
          {created.name} is live
        </Text>
        <Text className='text-[#9899A1] text-xs mb-4'>
          Your node is its first member. Send this code to whoever should join.
        </Text>
        <InviteCard group={created.id} groupName={created.name} />
      </View>
    );
  }

  return (
    <View>
      <Text className='text-white text-lg font-semibold mb-1'>New group</Text>
      <Text className='text-[#9899A1] text-xs mb-4'>
        A group is a set of nodes that pool their libraries. Nothing leaves a
        group, there is no public directory, and the only way in is an invite
        code.
      </Text>

      <TextInput
        className='p-4 rounded-xl bg-neutral-900'
        style={{ color: "white" }}
        placeholder='Group name'
        placeholderTextColor='#9CA3AF'
        autoCapitalize='words'
        autoCorrect={false}
        value={name}
        editable={!create.isPending}
        onChangeText={setName}
        // A TV remote has no soft keyboard shortcut for "done", so submitting from the field
        // itself is what saves a trip down to the button.
        returnKeyType='done'
        onSubmitEditing={() => ready && !create.isPending && void onCreate()}
      />

      <View className='h-4' />

      <CoordinatorPicker
        value={coordinator}
        onChange={setCoordinator}
        disabled={create.isPending}
      />

      <View className='h-6' />

      <Button
        onPress={onCreate}
        disabled={!ready}
        loading={create.isPending}
        hasTVPreferredFocus={Platform.isTV && ready}
      >
        Create group
      </Button>
    </View>
  );
}
