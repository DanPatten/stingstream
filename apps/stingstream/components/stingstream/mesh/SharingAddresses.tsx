import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
import { FormError } from "@/components/common/FormError";
import { Text } from "@/components/common/Text";
import {
  useMeshSharingSettings,
  useSetMeshSharingSettings,
} from "@/lib/stingstream/mesh";
import { isUntouched } from "@/utils/mesh/sharingAddress";
import {
  SharingAddress,
  type SharingAddressValue,
  sharingAddress,
  sharingAddressReady,
  sharingAddressUrl,
} from "./SharingAddress";

/**
 * This server's own address, under **Advanced** on the Sharing screen.
 *
 * There used to be two fields here: this one, and the address of a *sharing server* that introduced
 * members to each other. That second one is gone with the coordinator — a group needs nothing
 * hosted now, and every earlier version of this screen existed to ask a question about it that
 * nobody could answer.
 *
 * What is left is the only address that was ever really a setting, and it is optional. Without one,
 * this server is reachable on its own network and through the StingStream app anywhere; with one,
 * an invite becomes a link somebody can open in a browser from anywhere. Folded away because most
 * people will not have a domain, and the product works without one.
 */
export function SharingAddresses() {
  const { t } = useTranslation();
  const settings = useMeshSharingSettings();
  const save = useSetMeshSharingSettings();

  const [own, setOwn] = useState<SharingAddressValue>(sharingAddress());
  const [loaded, setLoaded] = useState(false);
  const [explainerOpen, setExplainerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the field once, from whatever the node holds. Only once: re-seeding on every fetch would
  // overwrite what somebody is halfway through typing when the query refetches underneath them.
  useEffect(() => {
    if (loaded || !settings.data) return;
    setOwn(sharingAddress(settings.data.publicAddress ?? ""));
    setLoaded(true);
  }, [loaded, settings.data]);

  const ownStored = settings.data?.publicAddress;

  // `isUntouched` is why a value already stored survives a check that cannot run from this browser
  // — see its own comment. Only something actually typed has to satisfy the rules.
  const ready = isUntouched(own, ownStored) || sharingAddressReady(own);
  const changed = !isUntouched(own, ownStored);

  const onSave = async () => {
    setError(null);
    try {
      const stored = await save.mutateAsync({
        publicAddress: isUntouched(own, ownStored)
          ? (ownStored ?? null)
          : sharingAddressUrl(own),
      });
      // Show what was stored rather than what was typed: the node normalises (a bare hostname
      // becomes an origin, a trailing slash goes), and a field that silently disagrees with the
      // server is how somebody ends up debugging the wrong value.
      setOwn(sharingAddress(stored.publicAddress ?? ""));
      toast.success(t("sharing.own_saved"));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <View>
      <View style={{ marginBottom: 20 }}>
        <Text variant='caption' tone='secondary' weight='medium'>
          {t("sharing.own_field_label")}
        </Text>
        <Text
          variant='caption'
          tone='tertiary'
          style={{ marginTop: 2, marginBottom: 8 }}
        >
          {t("sharing.own_field_hint")}
        </Text>
        <SharingAddress
          value={own}
          onChange={setOwn}
          disabled={save.isPending}
          placeholder={t("sharing.own_field_placeholder")}
          blankHint={t("sharing.own_field_blank")}
          stored={ownStored}
          testID='sharing-own-address'
        />
      </View>

      <FormError message={error} />

      <Button
        onPress={onSave}
        disabled={!ready || !changed}
        loading={save.isPending}
        style={{ marginTop: 4 }}
      >
        {t("sharing.own_save")}
      </Button>

      {/* An icon, because a ghost button with nothing but a label reads as a stray heading rather
          than something to press — which is exactly how it looked in the audit screenshot. */}
      <Button
        variant='ghost'
        size='sm'
        icon='info'
        onPress={() => setExplainerOpen(true)}
        testID='sharing-address-explainer'
        style={{ alignSelf: "flex-start", marginTop: 8 }}
      >
        {t("sharing.address_learn_more")}
      </Button>

      <Dialog
        visible={explainerOpen}
        onClose={() => setExplainerOpen(false)}
        title={t("sharing.address_explainer_title")}
      >
        <View style={{ gap: 12 }}>
          <Explains
            title={t("sharing.address_explainer_own_title")}
            body={t("sharing.address_explainer_own_body")}
          />
          <Explains
            title={t("sharing.address_explainer_without_title")}
            body={t("sharing.address_explainer_without_body")}
          />
        </View>
      </Dialog>
    </View>
  );
}

const Explains = ({ title, body }: { title: string; body: string }) => (
  <View style={{ gap: 4 }}>
    <Text variant='body' weight='semibold'>
      {title}
    </Text>
    <Text variant='caption' tone='secondary'>
      {body}
    </Text>
  </View>
);
