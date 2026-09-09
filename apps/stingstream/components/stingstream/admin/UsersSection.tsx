import type { UserDto } from "@jellyfin/sdk/lib/generated-client/models";
import { getUserApi } from "@jellyfin/sdk/lib/utils/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Icon } from "@/components/common/Icon";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { radius, tokens } from "@/constants/theme";
import { SERVER_USERS_QUERY_KEY } from "@/lib/stingstream/serverUsers";
import { apiAtom } from "@/providers/JellyfinProvider";
import { getUserImageUrl } from "@/utils/jellyfin/image/getUserImageUrl";
import { ScreenHeaderRow } from "../shared/ScreenHeaderRow";
import { EmptyState, QueryState } from "../shared/ScreenState";

/** The user's own photo, or a lettered fallback tile — same idea as Manage's
 * poster thumbnails, so a row with no photo yet still reads as one. */
function Avatar({
  serverAddress,
  user,
  size = 36,
}: {
  serverAddress?: string;
  user: UserDto;
  size?: number;
}) {
  const url =
    serverAddress && user.Id
      ? getUserImageUrl({
          serverAddress,
          userId: user.Id,
          primaryImageTag: user.PrimaryImageTag,
          width: size * 2,
        })
      : null;

  if (!url) {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: tokens.color.bg["3"],
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name='user' size={size * 0.6} tone='tertiary' />
      </View>
    );
  }
  return (
    <Image
      source={{ uri: url }}
      contentFit='cover'
      transition={120}
      style={{ width: size, height: size, borderRadius: size / 2 }}
    />
  );
}

export function UsersSection() {
  const { t } = useTranslation();
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
    // Shared with the Sharing screen, which lists the same accounts as People. Two components
    // asking the same question of the same server must not be able to disagree about the answer,
    // and this one creates and deletes the rows the other shows.
    queryKey: SERVER_USERS_QUERY_KEY,
    queryFn: async () => {
      const res = await getUserApi(api!).getUsers();
      return res.data;
    },
    enabled: !!api,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: SERVER_USERS_QUERY_KEY });

  const createUser = useMutation({
    mutationFn: async () => {
      await getUserApi(api!).createUserByName({
        createUserByName: { Name: name, Password: password || undefined },
      });
    },
    onSuccess: () => {
      toast.success(t("admin.users_created_toast", { name }));
      setName("");
      setPassword("");
      setAddOpen(false);
      invalidate();
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : t("admin.users_create_error"),
      ),
  });

  const toggleDisabled = useMutation({
    mutationFn: async (userId: string) => {
      const user = users?.find((u) => u.Id === userId);
      if (!user?.Policy) throw new Error(t("admin.users_missing_policy"));
      await getUserApi(api!).updateUserPolicy({
        userId,
        userPolicy: { ...user.Policy, IsDisabled: !user.Policy.IsDisabled },
      });
    },
    onSuccess: invalidate,
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : t("admin.users_update_error"),
      ),
  });

  const resetPasswordMutation = useMutation({
    mutationFn: async (userId: string) => {
      await getUserApi(api!).updateUserPassword({
        userId,
        updateUserPassword: { ResetPassword: false, NewPw: resetPassword },
      });
    },
    onSuccess: () => {
      toast.success(t("admin.users_reset_success"));
      setResetTarget(null);
      setResetPassword("");
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : t("admin.users_reset_error"),
      ),
  });

  return (
    <View testID='admin-users'>
      <ScreenHeaderRow
        title={t("admin.users_title")}
        accessory={
          <Button
            variant='secondary'
            size='sm'
            icon={addOpen ? "close" : "add"}
            onPress={() => setAddOpen((v) => !v)}
          >
            {addOpen ? t("common.cancel") : t("admin.users_add_action")}
          </Button>
        }
      />

      {addOpen && (
        <View
          style={{
            borderRadius: radius.lg,
            backgroundColor: tokens.color.bg["1"],
            padding: 16,
            marginBottom: 12,
          }}
        >
          <Input
            placeholder={t("admin.users_username_placeholder")}
            autoCapitalize='none'
            value={name}
            onChangeText={setName}
            style={{ marginBottom: 8 }}
          />
          <Input
            placeholder={t("admin.users_password_placeholder")}
            secureTextEntry
            value={password}
            onChangeText={setPassword}
            style={{ marginBottom: 12 }}
          />
          <Button
            variant='primary'
            disabled={!name}
            loading={createUser.isPending}
            onPress={() => createUser.mutate()}
          >
            {t("admin.users_create_action")}
          </Button>
        </View>
      )}

      {resetTarget && (
        <View
          style={{
            borderRadius: radius.lg,
            backgroundColor: tokens.color.bg["1"],
            padding: 16,
            marginBottom: 12,
          }}
        >
          <Text weight='semibold' style={{ marginBottom: 8 }}>
            {t("admin.users_reset_title")}
          </Text>
          <Input
            placeholder={t("admin.users_reset_placeholder")}
            secureTextEntry
            value={resetPassword}
            onChangeText={setResetPassword}
            style={{ marginBottom: 12 }}
          />
          <View style={{ flexDirection: "row", gap: 12 }}>
            <Button
              variant='secondary'
              style={{ flex: 1 }}
              onPress={() => setResetTarget(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant='primary'
              style={{ flex: 1 }}
              loading={resetPasswordMutation.isPending}
              onPress={() => resetPasswordMutation.mutate(resetTarget)}
            >
              {t("admin.users_reset_action")}
            </Button>
          </View>
        </View>
      )}

      <QueryState isLoading={isLoading} error={error} onRetry={refetch}>
        {!users || users.length === 0 ? (
          <EmptyState title={t("admin.users_empty_title")} />
        ) : (
          <ListGroup>
            {users.map((user) => (
              <View
                key={user.Id}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  minHeight: 44,
                  paddingVertical: 8,
                  paddingHorizontal: 16,
                  backgroundColor: tokens.color.bg["1"],
                }}
              >
                <Avatar serverAddress={api?.basePath} user={user} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text
                    style={
                      user.Policy?.IsDisabled
                        ? { color: tokens.color.state.danger }
                        : undefined
                    }
                    numberOfLines={1}
                  >
                    {user.Name ?? ""}
                  </Text>
                  <Text
                    variant='caption'
                    tone='secondary'
                    numberOfLines={1}
                    style={{ marginTop: 2 }}
                  >
                    {[
                      user.Policy?.IsAdministrator
                        ? t("admin.users_administrator")
                        : null,
                      user.Policy?.IsDisabled
                        ? t("admin.users_disabled")
                        : t("admin.users_enabled"),
                      user.HasPassword ? null : t("admin.users_no_password"),
                    ]
                      .filter(Boolean)
                      .join(" • ")}
                  </Text>
                </View>
                <View style={{ flexDirection: "row", gap: 16 }}>
                  <Text
                    tone='accent'
                    weight='semibold'
                    onPress={() => setResetTarget(user.Id ?? null)}
                  >
                    {t("admin.users_reset_password_action")}
                  </Text>
                  <Text
                    tone={user.Policy?.IsDisabled ? undefined : "danger"}
                    style={
                      user.Policy?.IsDisabled
                        ? { color: tokens.color.state.success }
                        : undefined
                    }
                    weight='semibold'
                    onPress={() => toggleDisabled.mutate(user.Id ?? "")}
                  >
                    {user.Policy?.IsDisabled
                      ? t("admin.users_enable_action")
                      : t("admin.users_disable_action")}
                  </Text>
                </View>
              </View>
            ))}
          </ListGroup>
        )}
      </QueryState>
    </View>
  );
}
