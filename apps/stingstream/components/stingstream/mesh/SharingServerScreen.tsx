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
import { FormCard } from "./FormCard";
import {
  DEFAULT_SHARING_SERVER,
  SharingAddress,
  type SharingAddressValue,
  sharingAddress,
  sharingAddressReady,
  sharingAddressUrl,
} from "./SharingAddress";

/**
 * Settings → Sharing → **Sharing server**: the two addresses this node uses.
 *
 * They are on a settings page rather than on the New group screen because that screen asks one
 * question — Public or Private — and a question with a text field bolted to one of its answers is
 * how the old coordinator picker became unreadable. Dan's instruction was to put the box here and
 * leave a link there.
 *
 * **Two fields, not one.** The first attempt at this used a single auto-detecting box, on the
 * theory that "where people reach you" was one idea. It is not. Which server introduces members,
 * and which domain a link points at, are independent: you can be Public through the shared server
 * *and* have your own domain for links, or Private *and* have one. A single box forces a choice
 * between them that does not exist, which is precisely the confusion it was meant to remove.
 *
 * Neither field is required. With both empty this node makes Private groups and hands out codes,
 * which is a complete and supported way to use StingStream — it is what the mesh has always done.
 */
export function SharingServerScreen() {
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

  // `isUntouched` is why a value already stored survives a check that cannot run from here — see
  // its own comment. Only something actually typed has to satisfy the probe.
  const untouched = isUntouched;

  const serverStored = settings.data?.coordinatorDefault;
  const ownStored = settings.data?.publicAddress;

  const ready =
    (untouched(server, serverStored) ||
      sharingAddressReady(server, "coordinator")) &&
    (untouched(own, ownStored) || sharingAddressReady(own, "own-server"));

  const onSave = async () => {
    setError(null);
    const next: MeshSharingSettings = {
      coordinatorDefault: untouched(server, serverStored)
        ? (serverStored ?? null)
        : sharingAddressUrl(server, "coordinator"),
      publicAddress: untouched(own, ownStored)
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
    <FormCard>
      <Text variant='title' weight='semibold'>
        {t("sharing.server_page_title")}
      </Text>
      <Text
        variant='caption'
        tone='secondary'
        style={{ marginTop: 4, marginBottom: 20 }}
      >
        {t("sharing.server_page_detail")}
      </Text>

      <Field
        label={t("sharing.server_field_label")}
        hint={t("sharing.server_field_hint")}
      >
        <SharingAddress
          value={server}
          onChange={setServer}
          accept='coordinator'
          disabled={save.isPending}
          placeholder={DEFAULT_SHARING_SERVER}
          blankHint={t("sharing.server_field_blank")}
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
          testID='sharing-own-address'
        />
      </Field>

      <FormError message={error} />

      <View style={{ height: 20 }} />

      <Button onPress={onSave} disabled={!ready} loading={save.isPending}>
        {t("sharing.server_save")}
      </Button>

      <Button
        variant='ghost'
        size='sm'
        onPress={() => setExplainerOpen(true)}
        testID='sharing-address-explainer'
        style={{ alignSelf: "flex-start", marginTop: 12 }}
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
            title={t("sharing.address_explainer_shared_title")}
            body={t("sharing.address_explainer_shared_body")}
          />
          <Explains
            title={t("sharing.address_explainer_empty_title")}
            body={t("sharing.address_explainer_empty_body")}
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
    </FormCard>
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
