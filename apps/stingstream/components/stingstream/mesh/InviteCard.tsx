import { requireOptionalNativeModule } from "expo";
import { useCallback, useEffect } from "react";
import { Platform, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Text } from "@/components/common/Text";
import { useMintMeshInvite } from "@/lib/stingstream/mesh";
import { LoadingState } from "../shared/ScreenState";

/**
 * An invite code, as text and as a QR.
 *
 * An invite carries the group id, its **secret**, this node's address and the group's coordinator
 * — everything needed to become a member. So it is minted on demand rather than displayed by
 * default, it is never cached by React Query, and the screen says plainly what handing it over
 * means. base58check is what makes it survivable when read aloud: no look-alike characters, and a
 * checksum that catches a transposition before it becomes a confusing join failure.
 *
 * The QR is the same string, not a URL. Anything that scans it and does not know what it is gets
 * an opaque blob, which is the right outcome.
 */
export function InviteCard({
  group,
  groupName,
}: {
  group: string;
  groupName: string;
}) {
  const mint = useMintMeshInvite();
  const code = mint.data?.code;

  useEffect(() => {
    mint.mutate(group);
    // Once per group. Re-minting on every render would hand out a new code each time the screen
    // re-rendered, which is harmless but makes the displayed code flicker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group]);

  const copy = useCallback(async () => {
    if (!code) return;
    if (Platform.OS === "web") {
      try {
        await navigator.clipboard.writeText(code);
        toast.success("Invite code copied");
      } catch {
        toast.error("Could not copy — select the code and copy it by hand.");
      }
      return;
    }
    // Builds that do not ship the expo-clipboard native module: probe first, as the rest of the
    // app does (components/settings/QuickConnect.tsx).
    if (!requireOptionalNativeModule("ExpoClipboard")) {
      toast.error("Clipboard is not available in this build.");
      return;
    }
    const Clipboard = await import("expo-clipboard");
    await Clipboard.setStringAsync(code);
    toast.success("Invite code copied");
  }, [code]);

  if (mint.isPending) return <LoadingState />;

  if (mint.error || !code) {
    return (
      <View className='rounded-xl bg-neutral-900 p-4'>
        <Text className='text-red-500 font-semibold'>
          Could not mint an invite
        </Text>
        <Text className='text-[#9899A1] text-xs mt-1'>
          {mint.error instanceof Error ? mint.error.message : "Unknown error"}
        </Text>
        <View className='h-3' />
        <Button color='black' onPress={() => mint.mutate(group)}>
          Try again
        </Button>
      </View>
    );
  }

  return (
    <View className='rounded-xl bg-neutral-900 p-4'>
      <Text className='text-white font-semibold'>
        Invite to {groupName || "this group"}
      </Text>
      <Text className='text-[#9899A1] text-xs mt-1'>
        This code carries the group secret. Anyone who has it can join and see
        everything the group holds, so send it the way you would send a
        password.
      </Text>

      <View className='items-center my-4'>
        <View className='p-3 rounded-xl bg-white'>
          <QRCode
            value={code}
            size={Platform.isTV ? 260 : 200}
            color='#000000'
            backgroundColor='#FFFFFF'
          />
        </View>
      </View>

      <View className='rounded-lg bg-neutral-800 p-3'>
        <Text className='text-white text-xs' selectable>
          {code}
        </Text>
      </View>

      {!Platform.isTV && (
        <>
          <View className='h-3' />
          <Button color='black' onPress={copy}>
            Copy code
          </Button>
        </>
      )}

      <Text className='text-[#9899A1] text-xs mt-3'>
        Joining needs a member online, so keep this node running until they are
        in — unless the group has a coordinator, which remembers member
        addresses for exactly this case.
      </Text>
    </View>
  );
}
