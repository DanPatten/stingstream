import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
import { FormError } from "@/components/common/FormError";
import { Text } from "@/components/common/Text";
import {
  type MeshSharingSettings,
  useMeshSharingSettings,
  useSetMeshSharingSettings,
} from "@/lib/stingstream/mesh";
import { COORDINATOR_GUIDE_URL } from "@/utils/mesh/coordinator";
import { isUntouched } from "@/utils/mesh/sharingAddress";
import {
  SharingAddress,
  type SharingAddressValue,
  sharingAddress,
  sharingAddressReady,
  sharingAddressUrl,
} from "./SharingAddress";

/**
 * The two addresses this server uses, under **Advanced** on the Sharing screen.
 *
 * They are here, folded away, because neither is a decision anybody has to make. The sharing server
 * arrives already set (`sharing::DEFAULT_SHARING_SERVER`, seeded when the database is first
 * opened), and your own domain is for people who have one. Every earlier version of this put one or
 * both in front of somebody creating a group and asked them to choose — a picker, then a field, then
 * a radio — and each time the answer was that nobody knows what to pick, because it is not a
 * question about them.
 *
 * What is left is a settings section: it says what the values do, and it is where you go when you
 * want to change one.
 */
export function SharingAddresses() {
  const { t } = useTranslation();
  const settings = useMeshSharingSettings();
  const save = useSetMeshSharingSettings();

  const [server, setServer] = useState<SharingAddressValue>(sharingAddress());
  const [own, setOwn] = useState<SharingAddressValue>(sharingAddress());
  const [loaded, setLoaded] = useState(false);
  const [explainerOpen, setExplainerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the fields once, from whatever the node holds. Only once: re-seeding on every fetch would
  // overwrite what somebody is halfway through typing when the query refetches underneath them.
  useEffect(() => {
    if (loaded || !settings.data) return;
    setServer(sharingAddress(settings.data.coordinatorDefault ?? ""));
    setOwn(sharingAddress(settings.data.publicAddress ?? ""));
    setLoaded(true);
  }, [loaded, settings.data]);

  const serverStored = settings.data?.coordinatorDefault;
  const ownStored = settings.data?.publicAddress;

  // `isUntouched` is why a value already stored survives a check that cannot run from this browser
  // — see its own comment. Only something actually typed has to satisfy the probe.
  const ready =
    (isUntouched(server, serverStored) ||
      sharingAddressReady(server, "coordinator")) &&
    (isUntouched(own, ownStored) || sharingAddressReady(own, "own-server"));

  const changed =
    !isUntouched(server, serverStored) || !isUntouched(own, ownStored);

  const onSave = async () => {
    setError(null);
    const next: MeshSharingSettings = {
      coordinatorDefault: isUntouched(server, serverStored)
        ? (serverStored ?? null)
        : sharingAddressUrl(server, "coordinator"),
      publicAddress: isUntouched(own, ownStored)
        ? (ownStored ?? null)
        : sharingAddressUrl(own, "own-server"),
    };
    try {
      const stored = await save.mutateAsync(next);
      // Show what was stored rather than what was typed: the node normalises (a bare hostname
      // becomes an origin, a trailing slash goes), and a field that silently disagrees with the
      // server is how somebody ends up debugging the wrong value.
      setServer(sharingAddress(stored.coordinatorDefault ?? ""));
      setOwn(sharingAddress(stored.publicAddress ?? ""));
      toast.success(t("sharing.server_saved"));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <View>
      <Field
        label={t("sharing.server_field_label")}
        hint={t("sharing.server_field_hint")}
      >
        <SharingAddress
          value={server}
          onChange={setServer}
          accept='coordinator'
          disabled={save.isPending}
          placeholder={t("sharing.server_field_placeholder")}
          blankHint={t("sharing.server_field_blank")}
          stored={serverStored}
          testID='sharing-server-address'
        />
      </Field>

      <Field
        label={t("sharing.own_field_label")}
        hint={t("sharing.own_field_hint")}
      >
        <SharingAddress
          value={own}
          onChange={setOwn}
          accept='own-server'
          disabled={save.isPending}
          placeholder={t("sharing.own_field_placeholder")}
          blankHint={t("sharing.own_field_blank")}
          stored={ownStored}
          testID='sharing-own-address'
        />
      </Field>

      <FormError message={error} />

      <Button
        onPress={onSave}
        disabled={!ready || !changed}
        loading={save.isPending}
        style={{ marginTop: 4 }}
      >
        {t("sharing.server_save")}
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
            title={t("sharing.address_explainer_server_title")}
            body={t("sharing.address_explainer_server_body")}
          />
          <Explains
            title={t("sharing.address_explainer_own_title")}
            body={t("sharing.address_explainer_own_body")}
          />
          {/*
            The one thing words cannot cover: the actual steps. Running a sharing server of your own
            is a deployment, not a setting, so it belongs in a guide — and a modal that explains a
            choice without saying where to go next is only half of it.
          */}
          <Button
            variant='secondary'
            size='sm'
            icon='link'
            onPress={() => void Linking.openURL(COORDINATOR_GUIDE_URL)}
            testID='sharing-address-guide'
            style={{ alignSelf: "flex-start" }}
          >
            {t("sharing.address_explainer_guide")}
          </Button>
        </View>
      </Dialog>
    </View>
  );
}

const Field = ({
  label,
  hint,
  children,
}: React.PropsWithChildren<{ label: string; hint: string }>) => (
  <View style={{ marginBottom: 20 }}>
    <Text variant='caption' tone='secondary' weight='medium'>
      {label}
    </Text>
    <Text
      variant='caption'
      tone='tertiary'
      style={{ marginTop: 2, marginBottom: 8 }}
    >
      {hint}
    </Text>
    {children}
  </View>
);

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
