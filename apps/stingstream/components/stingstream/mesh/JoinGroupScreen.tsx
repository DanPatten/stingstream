import { requireOptionalNativeModule } from "expo";
import { useCallback, useState } from "react";
import { Platform, TextInput, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Text } from "@/components/common/Text";
import useRouter from "@/hooks/useAppRouter";
import { useJoinMeshGroupOnNode } from "@/lib/stingstream/mesh";
import { useMesh } from "@/providers/MeshProvider";

/**
 * Join a group with someone else's invite code.
 *
 * The **home node** joins; this device follows, because a phone that were a member on its own
 * would have a group its node knew nothing about and a library that never showed it.
 *
 * Three ways in, in the order they are useful on each platform: scan a QR (phone), paste from the
 * clipboard (phone and web), type it out (everywhere, and the only option on a TV — which is why
 * base58 has no look-alike characters).
 */

type CameraModule = typeof import("expo-camera");

// Phones only. `require` at module scope is what took down the web bundle during the M2 spike
// (docs/M2-web-spike.md §1), so the platform check has to be here rather than inside a component.
const ExpoCamera: CameraModule | null =
  Platform.OS === "android" || Platform.OS === "ios"
    ? Platform.isTV
      ? null
      : require("expo-camera")
    : null;

export function JoinGroupScreen() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [scanning, setScanning] = useState(false);
  const join = useJoinMeshGroupOnNode();
  const mesh = useMesh();

  const submit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      try {
        const result = await join.mutateAsync(trimmed);
        // A join with nobody reachable still succeeds — the group exists locally and syncs when a
        // member appears — so say which happened rather than showing a bare "Joined".
        if (result.via === "none") {
          toast.warning(
            `Joined ${result.name}, but nobody answered. It will sync when a member comes online.`,
          );
        } else {
          toast.success(`Joined ${result.name} via the ${result.via}`);
        }
        await mesh.syncGroups();
        router.back();
      } catch (error) {
        toast.error((error as Error).message);
      }
    },
    [join, mesh, router],
  );

  const paste = useCallback(async () => {
    if (Platform.OS === "web") {
      try {
        setCode((await navigator.clipboard.readText()).trim());
      } catch {
        toast.error("The browser would not share the clipboard.");
      }
      return;
    }
    if (!requireOptionalNativeModule("ExpoClipboard")) return;
    const Clipboard = await import("expo-clipboard");
    const text = await Clipboard.getStringAsync();
    if (text?.trim()) setCode(text.trim());
  }, []);

  if (scanning && ExpoCamera) {
    return (
      <InviteScanner
        camera={ExpoCamera}
        onCancel={() => setScanning(false)}
        onScanned={(value) => {
          setScanning(false);
          setCode(value);
          void submit(value);
        }}
      />
    );
  }

  return (
    <View>
      <Text className='text-white text-lg font-semibold mb-1'>
        Join a group
      </Text>
      <Text className='text-[#9899A1] text-xs mb-4'>
        Paste the invite code a member sent you. It carries the group's address
        and secret, so treat it like a password — and it only works while a
        member is online, unless the group has a coordinator.
      </Text>

      <TextInput
        className='p-4 rounded-xl bg-neutral-900'
        style={{ color: "white" }}
        placeholder='Invite code'
        placeholderTextColor='#9CA3AF'
        autoCapitalize='none'
        autoCorrect={false}
        autoComplete='off'
        multiline={!Platform.isTV}
        value={code}
        editable={!join.isPending}
        onChangeText={setCode}
        returnKeyType='done'
        onSubmitEditing={() => void submit(code)}
      />

      <View className='h-4' />

      <Button
        onPress={() => submit(code)}
        disabled={!code.trim()}
        loading={join.isPending}
        hasTVPreferredFocus={Platform.isTV && !!code.trim()}
      >
        Join group
      </Button>

      {!Platform.isTV && (
        <>
          <View className='h-3' />
          <Button color='black' onPress={paste}>
            Paste from clipboard
          </Button>
        </>
      )}

      {ExpoCamera && (
        <>
          <View className='h-3' />
          <Button color='black' onPress={() => setScanning(true)}>
            Scan QR code
          </Button>
        </>
      )}

      {Platform.isTV && (
        <Text className='text-[#9899A1] text-xs mt-4'>
          There is no camera here, so the code has to be typed. Invite codes use
          base58, which has no look-alike characters — no 0/O and no 1/l/I — and
          carries a checksum, so a mistyped code is refused rather than
          half-joining.
        </Text>
      )}
    </View>
  );
}

/**
 * The camera. A separate component so its hooks only ever run where `expo-camera` exists —
 * conditionally calling `useCameraPermissions` from the screen above would break the rules of
 * hooks the moment the platform changed.
 */
function InviteScanner({
  camera,
  onScanned,
  onCancel,
}: {
  camera: CameraModule;
  onScanned: (code: string) => void;
  onCancel: () => void;
}) {
  const [permission, requestPermission] = camera.useCameraPermissions();
  const [seen, setSeen] = useState(false);

  if (!permission) {
    return <Text className='text-[#9899A1]'>Checking camera access…</Text>;
  }

  if (!permission.granted) {
    return (
      <View>
        <Text className='text-white font-semibold mb-1'>Camera access</Text>
        <Text className='text-[#9899A1] text-xs mb-4'>
          Scanning an invite needs the camera. You can always type the code
          instead.
        </Text>
        <Button onPress={() => void requestPermission()}>
          Allow camera access
        </Button>
        <View className='h-3' />
        <Button color='black' onPress={onCancel}>
          Type it instead
        </Button>
      </View>
    );
  }

  const CameraView = camera.CameraView;
  return (
    <View>
      <View className='rounded-2xl overflow-hidden' style={{ height: 340 }}>
        <CameraView
          style={{ flex: 1 }}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={({ data }) => {
            // The camera fires this many times a second for the same code; the first one wins.
            if (seen || !data) return;
            setSeen(true);
            onScanned(data.trim());
          }}
        />
      </View>
      <Text className='text-[#9899A1] text-xs mt-3 text-center'>
        Point the camera at the invite QR on the other device.
      </Text>
      <View className='h-3' />
      <Button color='black' onPress={onCancel}>
        Cancel
      </Button>
    </View>
  );
}
