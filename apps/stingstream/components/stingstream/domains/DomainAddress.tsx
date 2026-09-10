import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { FormError } from "@/components/common/FormError";
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
 * The address people reach this server at.
 *
 * There used to be two fields here: this one, and the address of a *sharing server* that introduced
 * members to each other. That second one is gone with the coordinator — a group needs nothing
 * hosted now, and every earlier version of this screen existed to ask a question about it that
 * nobody could answer.
 *
 * What is left is the only address that was ever really a setting, and it is optional. Without one,
 * this server is reachable on its own network and through the StingStream app anywhere; with one,
 * an invite becomes a link somebody can open in a browser from anywhere.
 *
 * It was folded into an **Advanced** disclosure at the bottom of Servers, on the reasoning that
 * most people will not have a domain and the product works without one. Both halves of that were
 * true and the conclusion was still wrong: this is the one control that decides whether anybody
 * can reach the server from a browser away from home, and `InvitePerson` had to deep-link to it
 * with `?advanced=1` to prise the fold open whenever a minted invite turned out to be LAN-only.
 * It is the second block of its own page now, under the status that says whether it is working.
 */
export function DomainAddress() {
  const { t } = useTranslation();
  const settings = useMeshSharingSettings();
  const save = useSetMeshSharingSettings();

  const [own, setOwn] = useState<SharingAddressValue>(sharingAddress());
  const [loaded, setLoaded] = useState(false);
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
      <View style={{ marginBottom: 16 }}>
        {/* No label and no preamble. The card is titled "Your server's address", the status above
            says which address is in use, and this is the box you type one into -- three
            explanations of the same field was the "overly complicated and verbose" Dan was
            reading. What the field is *for* is one short line, below, from `SharingAddress`. */}
        <SharingAddress
          value={own}
          onChange={setOwn}
          disabled={save.isPending}
          placeholder={t("sharing.own_field_placeholder")}
          stored={ownStored}
          testID='sharing-own-address'
        />
      </View>

      <FormError message={error} />

      <Button
        onPress={onSave}
        disabled={!ready || !changed}
        loading={save.isPending}
        // Sized to its label, not the card. Full width, it was a teal bar dominating a section
        // whose actual subject is the address above it -- and it is disabled most of the time,
        // since it only lights up once something has been typed.
        style={{ alignSelf: "flex-start", marginTop: 4 }}
      >
        {t("sharing.own_save")}
      </Button>
    </View>
  );
}
