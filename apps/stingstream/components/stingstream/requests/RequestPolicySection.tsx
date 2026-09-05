import { useEffect, useState } from "react";
import { View } from "react-native";
import { toast } from "sonner-native";
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
import { SaveBar, TextFieldRow, ToggleRow } from "../settings/fields";
import { QueryState } from "../shared/ScreenState";
import { SegmentedControl } from "../shared/SegmentedControl";

const MODES: { key: AutoApproveMode; label: string; detail: string }[] = [
  {
    key: "everyone",
    label: "Everyone",
    detail:
      "Every member's requests start straight away. Best in a household where everybody already shares the bandwidth.",
  },
  {
    key: "trusted",
    label: "Trusted",
    detail:
      "Administrators and the members you have marked trusted below skip the queue; everybody else waits.",
  },
  {
    key: "admins_only",
    label: "Administrators",
    detail:
      "Only an administrator's own requests skip the queue. Every other request waits for a decision.",
  },
];

/**
 * Who may spend the group's bandwidth without asking, and how much.
 *
 * The policy is per *group*, not per node: a request costs the group a download, and whether a
 * person may spend that is a property of the group they are spending it in. A node in two groups
 * has two policies, and this screen edits the one the picker on Discover would use.
 */
export function RequestPolicySection() {
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
      toast.success("Request policy saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
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
          ? `${userName} is now trusted`
          : `${userName} is no longer trusted`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <QueryState
      isLoading={policy.isLoading}
      error={policy.error}
      onRetry={policy.refetch}
    >
      <Text className='text-white text-lg font-semibold mb-2'>
        Who needs approval
      </Text>
      <View className='-mx-4'>
        <SegmentedControl
          segments={MODES.map((m) => ({ key: m.key, label: m.label }))}
          value={mode}
          onChange={(key) => {
            setMode(key as AutoApproveMode);
            setDirty(true);
          }}
        />
      </View>
      <Text className='text-[#9899A1] text-xs mt-2 mb-3'>
        {MODES.find((m) => m.key === mode)?.detail}
      </Text>

      <ListGroup>
        <TextFieldRow
          title='Requests per week'
          subtitle='Per member. 0 means no limit. Declined requests do not count.'
          value={quota}
          onChangeText={(v) => {
            setQuota(v);
            setDirty(true);
          }}
          keyboardType='number-pad'
          placeholder='0'
        />
      </ListGroup>

      <SaveBar
        dirty={dirty}
        saving={savePolicy.isPending}
        onSave={save}
        onDiscard={() => {
          if (policy.data) {
            setMode(policy.data.autoApprove);
            setQuota(String(policy.data.weeklyQuota));
          }
          setDirty(false);
        }}
      />

      <View className='h-6' />

      <Text className='text-white text-lg font-semibold mb-2'>Members</Text>
      <QueryState
        isLoading={users.isLoading}
        error={users.error}
        onRetry={users.refetch}
      >
        <ListGroup>
          {(users.data ?? []).map((user) =>
            user.isAdministrator ? (
              // An administrator can change this policy, so making them wait for an approval they
              // could grant themselves is theatre -- the node auto-approves them under every mode
              // and there is no switch to offer.
              <ListItem
                key={user.userId}
                title={user.userName}
                subtitle={`Administrator • ${user.requestsThisWeek} request(s) this week`}
              />
            ) : (
              <ToggleRow
                key={user.userId}
                title={user.userName}
                subtitle={`${user.requestsThisWeek} request(s) this week${
                  user.weeklyQuota > 0 ? ` • own limit ${user.weeklyQuota}` : ""
                }`}
                value={user.trusted}
                onValueChange={(v) =>
                  setTrust(user.userId, user.userName, v, user.weeklyQuota)
                }
              />
            ),
          )}
        </ListGroup>
        <Text className='text-[#9899A1] text-xs mt-2'>
          Trusted members skip the queue under the Trusted policy. It has no
          effect under the other two.
        </Text>
      </QueryState>
    </QueryState>
  );
}
