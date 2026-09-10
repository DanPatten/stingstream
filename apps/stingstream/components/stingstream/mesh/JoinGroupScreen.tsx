import { requireOptionalNativeModule } from "expo";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { FormError } from "@/components/common/FormError";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import useRouter from "@/hooks/useAppRouter";
import { useJoinMeshGroupOnNode } from "@/lib/stingstream/mesh";
import { useMesh } from "@/providers/MeshProvider";
import { parseInviteInput } from "@/utils/mesh/inviteLink";
import { takePendingInvite } from "@/utils/mesh/pendingInvite";
import { FormCard } from "./FormCard";

/**
 * Join a group with someone else's invite code.
 *
 * The **server** joins; this device follows, because a phone that were a member on its own would
 * have a group its server knew nothing about and a library that never showed it.
 *
 * Three ways in, in the order they are useful on each platform: scan a QR (phone), paste from the
 * clipboard (phone and web), type it out (everywhere, and the only option on a TV — which is why
 * base58 has no look-alike characters).
 *
 * All three take **a link or a bare code**, because both are in circulation: an invite is a link
 * when the minting node has an address to build one from and a code when it does not, and every
 * invite handed out before that existed is a code. `parseInviteInput` is the one place that tells
 * them apart, so the field, the clipboard and the scanner cannot disagree.
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

/**
 * Where an invite link lands, and the only reason this route still exists.
 *
 * It is not a page anybody browses to. Nothing links here: the Servers screen used to carry a
 * "Join with a link" button beside two others and Dan's verdict was that nobody could tell them
 * apart. What sends you here is `app/join.tsx`, which catches an invite code out of the fragment
 * before the router can navigate, remembers it, and replaces to this route — see `/join`'s own
 * docblock for why the code cannot simply be read here.
 *
 * So this is the far end of exactly one journey: somebody asked to link the server they run, an
 * administrator approved it, and the invite that came back opens here on *their* server. The code
 * is filled in rather than submitted, because joining puts this server into somebody else's group
 * and that is worth one deliberate tap.
 *
 * The paste and scan controls stay for the same journey's awkward cases — a link whose fragment a
 * chat client ate, or a TV with no browser to open it in.
 */
export function JoinGroupScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const [code, setCode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const join = useJoinMeshGroupOnNode();
  const mesh = useMesh();

  // Somebody arrived here by opening an invite link. `/join` caught the code before the router
  // could navigate; this is where it lands. Filled in rather than submitted: joining puts this
  // server into someone else's group, which is worth one deliberate tap.
  useEffect(() => {
    const pending = takePendingInvite();
    if (pending) setCode(pending);
  }, []);

  const submit = useCallback(
    async (value: string) => {
      if (!value.trim()) return;
      setError(null);
      const parsed = parseInviteInput(value);
      if (!parsed) {
        // Almost always a link whose fragment was stripped — by a chat client, or by copying the
        // address bar of a page that had already consumed it. Sending it on as a code would come
        // back from the node as "not valid base58check", which names the symptom and hides the
        // cause; this says what to do about it.
        setError(t("sharing.join_link_incomplete"));
        return;
      }
      try {
        const result = await join.mutateAsync(parsed);
        // A join with nobody reachable still succeeds — the group exists locally and syncs when a
        // member appears — so say which happened rather than showing a bare "Joined".
        if (result.via === "none") {
          toast.warning(
            t("sharing.join_success_no_answer", { name: result.name }),
          );
        } else {
          toast.success(
            t("sharing.join_success", { name: result.name, via: result.via }),
          );
        }
        await mesh.syncGroups();
        // Straight to the new link rather than back to the list. "Each side picks its own" means
        // the other server sees nothing of yours until you choose, and the moment you have just
        // accepted is the only moment you are certainly thinking about it. A list would leave the
        // link looking finished when it is half-made.
        router.replace(`/settings/servers/${result.group}`);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [join, mesh, router, t],
  );

  const paste = useCallback(async () => {
    if (Platform.OS === "web") {
      try {
        setCode((await navigator.clipboard.readText()).trim());
      } catch {
        toast.error(t("sharing.join_clipboard_denied"));
      }
      return;
    }
    if (!requireOptionalNativeModule("ExpoClipboard")) return;
    const Clipboard = await import("expo-clipboard");
    const text = await Clipboard.getStringAsync();
    if (text?.trim()) setCode(text.trim());
  }, [t]);

  if (scanning && ExpoCamera) {
    return (
      <FormCard>
        <InviteScanner
          camera={ExpoCamera}
          onCancel={() => setScanning(false)}
          onScanned={(value) => {
            setScanning(false);
            setCode(value);
            void submit(value);
          }}
        />
      </FormCard>
    );
  }

  return (
    <FormCard>
      <Text variant='title' weight='semibold'>
        {t("sharing.join_title")}
      </Text>
      <Text
        variant='caption'
        tone='secondary'
        style={{ marginTop: 4, marginBottom: 20 }}
      >
        {t("sharing.join_detail")}
      </Text>

      <Input
        placeholder={t("sharing.join_link_placeholder")}
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

      <FormError message={error} />

      <View style={{ height: 16 }} />

      <Button
        onPress={() => submit(code)}
        disabled={!code.trim()}
        loading={join.isPending}
        hasTVPreferredFocus={Platform.isTV && !!code.trim()}
      >
        {t("sharing.join_submit")}
      </Button>

      {/* Offered on a TV too. A remote has no keyboard worth typing 250 base58 characters on, and
          a code that arrived by a companion app or a browser on the same box is already in the
          clipboard — so this is the difference between a minute and five. */}
      <View style={{ height: 12 }} />
      <Button variant='secondary' icon='link' onPress={paste}>
        {t("sharing.join_paste")}
      </Button>

      {ExpoCamera && (
        <>
          <View style={{ height: 12 }} />
          <Button variant='secondary' onPress={() => setScanning(true)}>
            {t("sharing.join_scan")}
          </Button>
        </>
      )}

      {Platform.isTV && (
        <Text variant='caption' tone='secondary' style={{ marginTop: 16 }}>
          {t("sharing.join_tv_hint")}
        </Text>
      )}
    </FormCard>
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
  const { t } = useTranslation();
  const [permission, requestPermission] = camera.useCameraPermissions();
  const [seen, setSeen] = useState(false);

  if (!permission) {
    return (
      <Text variant='caption' tone='secondary'>
        {t("sharing.join_camera_checking")}
      </Text>
    );
  }

  if (!permission.granted) {
    return (
      <View>
        <Text variant='body' weight='semibold'>
          {t("sharing.join_camera_title")}
        </Text>
        <Text
          variant='caption'
          tone='secondary'
          style={{ marginTop: 4, marginBottom: 16 }}
        >
          {t("sharing.join_camera_detail")}
        </Text>
        <Button onPress={() => void requestPermission()}>
          {t("sharing.join_camera_allow")}
        </Button>
        <View style={{ height: 12 }} />
        <Button variant='secondary' onPress={onCancel}>
          {t("sharing.join_camera_type_instead")}
        </Button>
      </View>
    );
  }

  const CameraView = camera.CameraView;
  return (
    <View>
      <View style={{ height: 340, borderRadius: 16, overflow: "hidden" }}>
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
      <Text
        variant='caption'
        tone='secondary'
        align='center'
        style={{ marginTop: 12 }}
      >
        {t("sharing.join_camera_hint")}
      </Text>
      <View style={{ height: 12 }} />
      <Button variant='secondary' onPress={onCancel}>
        {t("sharing.join_camera_cancel")}
      </Button>
    </View>
  );
}
