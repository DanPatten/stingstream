import { getUserApi } from "@jellyfin/sdk/lib/utils/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { TextInput, TouchableOpacity, View } from "react-native";
import { toast } from "sonner-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { Colors } from "@/constants/Colors";
import { apiAtom } from "@/providers/JellyfinProvider";
import { EmptyState, QueryState } from "../shared/ScreenState";

export function UsersSection() {
  const api = useAtomValue(apiAtom);
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [resetTarget, setResetTarget] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  const {
    data: users,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["stingstream", "jellyfin-users"],
    queryFn: async () => {
      const res = await getUserApi(api!).getUsers();
      return res.data;
    },
    enabled: !!api,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: ["stingstream", "jellyfin-users"],
    });

  const createUser = useMutation({
    mutationFn: async () => {
      await getUserApi(api!).createUserByName({
        createUserByName: { Name: name, Password: password || undefined },
      });
    },
    onSuccess: () => {
      toast.success(`Created user "${name}"`);
      setName("");
      setPassword("");
      setAddOpen(false);
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Could not create user"),
  });

  const toggleDisabled = useMutation({
    mutationFn: async (userId: string) => {
      const user = users?.find((u) => u.Id === userId);
      if (!user?.Policy) throw new Error("Missing policy");
      await getUserApi(api!).updateUserPolicy({
        userId,
        userPolicy: { ...user.Policy, IsDisabled: !user.Policy.IsDisabled },
      });
    },
    onSuccess: invalidate,
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Could not update user"),
  });

  const resetPasswordMutation = useMutation({
    mutationFn: async (userId: string) => {
      await getUserApi(api!).updateUserPassword({
        userId,
        updateUserPassword: { ResetPassword: false, NewPw: resetPassword },
      });
    },
    onSuccess: () => {
      toast.success("Password reset");
      setResetTarget(null);
      setResetPassword("");
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Could not reset password",
      ),
  });

  return (
    <View>
      <View className='flex-row items-center justify-between mb-2'>
        <Text className='text-white text-lg font-semibold'>Users</Text>
        <TouchableOpacity onPress={() => setAddOpen((v) => !v)}>
          <Text className='text-[#0584FE] font-semibold'>
            {addOpen ? "Cancel" : "+ Add user"}
          </Text>
        </TouchableOpacity>
      </View>

      {addOpen && (
        <View className='rounded-xl bg-neutral-900 p-4 mb-3'>
          <TextInput
            placeholder='Username'
            placeholderTextColor='#5A5960'
            autoCapitalize='none'
            value={name}
            onChangeText={setName}
            className='bg-neutral-800 text-white rounded-lg px-3 py-2 mb-2'
          />
          <TextInput
            placeholder='Password (optional)'
            placeholderTextColor='#5A5960'
            secureTextEntry
            value={password}
            onChangeText={setPassword}
            className='bg-neutral-800 text-white rounded-lg px-3 py-2 mb-2'
          />
          <TouchableOpacity
            disabled={!name || createUser.isPending}
            onPress={() => createUser.mutate()}
            className='rounded-lg py-2 items-center'
            style={{ backgroundColor: Colors.primary }}
          >
            <Text className='text-white font-semibold'>
              {createUser.isPending ? "Creating…" : "Create user"}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {resetTarget && (
        <View className='rounded-xl bg-neutral-900 p-4 mb-3'>
          <Text className='text-white mb-2'>New password</Text>
          <TextInput
            placeholder='New password'
            placeholderTextColor='#5A5960'
            secureTextEntry
            value={resetPassword}
            onChangeText={setResetPassword}
            className='bg-neutral-800 text-white rounded-lg px-3 py-2 mb-2'
          />
          <View className='flex-row gap-3'>
            <TouchableOpacity
              onPress={() => setResetTarget(null)}
              className='flex-1 rounded-lg py-2 items-center bg-neutral-800'
            >
              <Text className='text-white'>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              disabled={resetPasswordMutation.isPending}
              onPress={() => resetPasswordMutation.mutate(resetTarget)}
              className='flex-1 rounded-lg py-2 items-center'
              style={{ backgroundColor: Colors.primary }}
            >
              <Text className='text-white font-semibold'>
                {resetPasswordMutation.isPending ? "Saving…" : "Reset"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <QueryState isLoading={isLoading} error={error} onRetry={refetch}>
        {!users || users.length === 0 ? (
          <EmptyState title='No users' />
        ) : (
          <ListGroup>
            {users.map((user) => (
              <ListItem
                key={user.Id}
                title={user.Name ?? ""}
                subtitle={[
                  user.Policy?.IsAdministrator ? "Administrator" : null,
                  user.Policy?.IsDisabled ? "Disabled" : "Enabled",
                  user.HasPassword ? null : "No password",
                ]
                  .filter(Boolean)
                  .join(" • ")}
                textColor={user.Policy?.IsDisabled ? "red" : "default"}
              >
                <View className='flex-row gap-4'>
                  <Text
                    className='text-[#0584FE]'
                    onPress={() => setResetTarget(user.Id ?? null)}
                  >
                    Reset password
                  </Text>
                  <Text
                    className={
                      user.Policy?.IsDisabled
                        ? "text-green-500"
                        : "text-red-600"
                    }
                    onPress={() => toggleDisabled.mutate(user.Id ?? "")}
                  >
                    {user.Policy?.IsDisabled ? "Enable" : "Disable"}
                  </Text>
                </View>
              </ListItem>
            ))}
          </ListGroup>
        )}
      </QueryState>
    </View>
  );
}
