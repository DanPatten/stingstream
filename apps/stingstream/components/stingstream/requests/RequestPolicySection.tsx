import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Icon } from "@/components/common/Icon";
import { Input } from "@/components/common/Input";
import { SettingSwitch } from "@/components/common/SettingSwitch";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import {
  type AutoApproveMode,
  useRequestPolicy,
  useRequestUsers,
  useSaveRequestPolicy,
  useSaveRequestUser,
} from "@/lib/stingstream/requests";
import { RequestCardSkeletonList } from "./RequestCard";
import { RequestsErrorState } from "./RequestsErrorState";

const MODES: AutoApproveMode[] = ["everyone", "trusted", "admins_only"];

/**
 * Who may spend the group's bandwidth without asking, and how much.
 *
 * The policy is per *group*, not per node: a request costs the group a download, and whether a
 * person may spend that is a property of the group they are spending it in. A node in two groups
 * has two policies, and this screen edits the one the picker on Discover would use.
 */
export function RequestPolicySection() {
  const { t } = useTranslation();
  const policy = useRequestPolicy();
  const users = useRequestUsers();
  const savePolicy = useSaveRequestPolicy();
  const saveUser = useSaveRequestUser();

  const [mode, setMode] = useState<AutoApproveMode>("trusted");
  const [quota, setQuota] = useState("0");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!policy.data) return;
    setMode(policy.data.autoApprove);
    setQuota(String(policy.data.weeklyQuota));
    setDirty(false);
  }, [policy.data]);

  const save = async () => {
    if (!policy.data) return;
    try {
      await savePolicy.mutateAsync({
        ...policy.data,
        autoApprove: mode,
        // A field a person typed into. Anything that is not a number means "no limit", which is
        // both the safe reading and what an empty box looks like.
        weeklyQuota: Number.parseInt(quota, 10) || 0,
      });
      setDirty(false);
      toast.success(t("requests.policy_saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const discard = () => {
    if (policy.data) {
      setMode(policy.data.autoApprove);
      setQuota(String(policy.data.weeklyQuota));
    }
    setDirty(false);
  };

  const setTrust = async (
    userId: string,
    userName: string,
    trusted: boolean,
    weeklyQuota: number,
  ) => {
    try {
      await saveUser.mutateAsync({ userId, trusted, weeklyQuota });
      toast.success(
        trusted
          ? t("requests.trusted_on", { name: userName })
          : t("requests.trusted_off", { name: userName }),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  if (policy.isLoading) return <RequestCardSkeletonList count={3} />;
  if (policy.error) {
    return <RequestsErrorState error={policy.error} onRetry={policy.refetch} />;
  }

  return (
    <View>
      <Text variant='heading' weight='semibold' style={{ marginBottom: 10 }}>
        {t("requests.policy_who_title")}
      </Text>
      <ListGroup>
        {MODES.map((key) => (
          <ListItem
            key={key}
            title={t(`requests.policy_mode_${key}_title`)}
            subtitle={t(`requests.policy_mode_${key}_detail`)}
            onPress={() => {
              setMode(key);
              setDirty(true);
            }}
          >
            {mode === key ? <Icon name='check' tone='accent' /> : null}
          </ListItem>
        ))}
      </ListGroup>

      <View style={{ marginTop: 16 }}>
        <Text variant='body' weight='semibold'>
          {t("requests.policy_quota_title")}
        </Text>
        <View style={{ marginTop: 8 }}>
          <Input
            value={quota}
            onChangeText={(v) => {
              setQuota(v);
              setDirty(true);
            }}
            keyboardType='number-pad'
            placeholder='0'
          />
        </View>
        <Text variant='caption' tone='secondary' style={{ marginTop: 6 }}>
          {t("requests.policy_quota_detail")}
        </Text>
      </View>

      {dirty ? (
        <View style={{ flexDirection: "row", gap: 8, marginTop: 16 }}>
          <Button variant='ghost' onPress={discard} style={{ flex: 1 }}>
            {t("requests.discard")}
          </Button>
          <Button
            variant='primary'
            loading={savePolicy.isPending}
            onPress={save}
            style={{ flex: 1 }}
          >
            {t("requests.save_changes")}
          </Button>
        </View>
      ) : null}

      <View style={{ height: 24 }} />

      <Text variant='heading' weight='semibold' style={{ marginBottom: 10 }}>
        {t("requests.policy_members_title")}
      </Text>
      {users.isLoading ? (
        <RequestCardSkeletonList count={3} />
      ) : users.error ? (
        <RequestsErrorState error={users.error} onRetry={users.refetch} />
      ) : (
        <>
          <ListGroup>
            {(users.data ?? []).map((user) =>
              user.isAdministrator ? (
                // An administrator can change this policy, so making them wait for an approval
                // they could grant themselves is theatre — the node auto-approves them under
                // every mode, and there is no switch to offer.
                <ListItem
                  key={user.userId}
                  title={user.userName}
                  subtitle={t("requests.policy_admin_row", {
                    count: user.requestsThisWeek,
                  })}
                />
              ) : (
                <ListItem
                  key={user.userId}
                  title={user.userName}
                  subtitle={
                    user.weeklyQuota > 0
                      ? t("requests.policy_member_row_quota", {
                          count: user.requestsThisWeek,
                          quota: user.weeklyQuota,
                        })
                      : t("requests.policy_member_row", {
                          count: user.requestsThisWeek,
                        })
                  }
                >
                  <SettingSwitch
                    value={user.trusted}
                    disabled={saveUser.isPending}
                    onValueChange={(v) =>
                      setTrust(user.userId, user.userName, v, user.weeklyQuota)
                    }
                  />
                </ListItem>
              ),
            )}
          </ListGroup>
          <Text variant='caption' tone='secondary' style={{ marginTop: 8 }}>
            {t("requests.policy_trust_hint")}
          </Text>
        </>
      )}
    </View>
  );
}
