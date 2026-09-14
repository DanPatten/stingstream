import { getNodeBaseUrl } from "@stingstream/api-client";
import { useAtomValue } from "jotai";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
import { FormError } from "@/components/common/FormError";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import { primaryAddressFor, useNodeContext } from "@/hooks/useNodeContext";
import { useServerName } from "@/hooks/useServerName";
import { useCreateConnectionInvite } from "@/lib/stingstream/connections";
import { apiAtom } from "@/providers/JellyfinProvider";
import { resolveServerOrigin } from "@/utils/identity/resolveServer";
import { buildInviteLink, buildStartLink } from "@/utils/mesh/connectionLink";
import { useIsStingStreamAdmin } from "../shared/RequiresAdmin";
import { copyInviteLink, goToServer, openInNewTab } from "./openOrCopy";
import { ShareLibrariesPicker } from "./ShareLibrariesPicker";

/**
 * *Add server*, beside the Servers title, for everybody.
 *
 * Dan: *"Always show add-server. If the user doing it ISNT an admin on that server - thats fine - we
 * ask them for their server's address (where they are an admin) -> redirect+login and we start over
 * there ... Otherwise if they ARE An admin on this one we already HAVE consent so we just start the
 * flow (first ask them what they want to share from this server."*
 *
 * **An administrator** chooses what this server shares and gets an invite link. There is no
 * question about the other server's address, because one link covers both people it is for: the
 * one who runs both servers opens it, and the one who does not sends it.
 *
 * **A member** gives the address of a server they administer and continues there. That server
 * makes the invite and sends it back here as a request, which an administrator approves once.
 */
export function AddServerButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        testID='sharing-add-server'
        variant='primary'
        size='sm'
        icon='add'
        onPress={() => setOpen(true)}
      >
        {t("sharing.add_server")}
      </Button>
      {open ? <AddServerDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function AddServerDialog({ onClose }: { onClose: () => void }) {
  const isAdmin = useIsStingStreamAdmin();
  return isAdmin ? (
    <InviteDialog onClose={onClose} />
  ) : (
    <OwnServerDialog onClose={onClose} />
  );
}

/** This server's address as somebody elsewhere reaches it, and its origin as this browser does. */
const useHere = () => {
  const node = useNodeContext();
  const api = useAtomValue(apiAtom);
  const fallback = api?.basePath ? getNodeBaseUrl(api.basePath) : null;
  return {
    shareable: node ? primaryAddressFor(node) : fallback,
    origin: node?.origin ?? fallback,
  };
};

function InviteDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const here = useHere();
  const create = useCreateConnectionInvite();
  const [selected, setSelected] = useState<string[] | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setError(null);
    try {
      const invite = await create.mutateAsync(selected);
      const url = buildInviteLink(here.shareable, invite);
      if (!url) throw new Error(t("sharing.add_server_failed"));
      setLink(url);
    } catch (e) {
      setError((e as Error)?.message || t("sharing.add_server_failed"));
    }
  }, [create, here.shareable, selected, t]);

  if (link) {
    return (
      <Dialog
        visible
        onClose={onClose}
        title={t("sharing.add_server_ready_title")}
        description={t("sharing.add_server_ready_detail")}
      >
        <View style={{ gap: 12 }}>
          <Text
            testID='sharing-invite-link'
            variant='caption'
            tone='tertiary'
            numberOfLines={2}
            selectable
          >
            {link}
          </Text>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            <Button
              testID='sharing-invite-copy'
              variant='primary'
              size='sm'
              icon='share'
              onPress={() => void copyInviteLink(link)}
            >
              {t("sharing.add_server_copy")}
            </Button>
            <Button
              testID='sharing-invite-open'
              variant='secondary'
              size='sm'
              icon='openExternal'
              onPress={() => openInNewTab(link)}
            >
              {t("sharing.add_server_open")}
            </Button>
          </View>
        </View>
      </Dialog>
    );
  }

  return (
    <Dialog
      visible
      onClose={onClose}
      title={t("sharing.share_title")}
      description={t("sharing.share_detail_other")}
    >
      <View style={{ gap: 12 }}>
        <ShareLibrariesPicker
          selected={selected}
          onChange={setSelected}
          disabled={create.isPending}
        />
        <FormError message={error} />
        <Button
          testID='sharing-invite-create'
          variant='primary'
          size='lg'
          loading={create.isPending}
          disabled={create.isPending}
          onPress={() => void submit()}
        >
          {t("sharing.add_server_create")}
        </Button>
      </View>
    </Dialog>
  );
}

function OwnServerDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const here = useHere();
  const serverName = useServerName();
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const typed = address.trim();
    if (!typed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const found = await resolveServerOrigin(typed);
      const url = found
        ? buildStartLink(found, {
            returnTo: here.origin ?? "",
            server: serverName ?? "",
          })
        : null;
      if (!url) {
        setError(t("identity.own_server_not_found"));
        return;
      }
      await goToServer(url);
      onClose();
    } catch (e) {
      setError((e as Error)?.message || t("identity.own_server_failed"));
    } finally {
      setBusy(false);
    }
  }, [address, busy, here.origin, onClose, serverName, t]);

  return (
    <Dialog
      visible
      onClose={onClose}
      title={t("sharing.own_server_title")}
      description={t("sharing.own_server_detail")}
    >
      <View style={{ gap: 12 }}>
        <Input
          testID='sharing-own-server-address'
          aria-label={t("sharing.server_address")}
          placeholder={t("identity.own_server_placeholder")}
          value={address}
          onChangeText={setAddress}
          autoCapitalize='none'
          autoCorrect={false}
          autoComplete='off'
          keyboardType='url'
          returnKeyType='go'
          editable={!busy}
          onSubmitEditing={() => void submit()}
        />
        <FormError message={error} />
        <Button
          testID='sharing-own-server-continue'
          variant='primary'
          size='lg'
          loading={busy}
          disabled={busy || address.trim().length === 0}
          onPress={() => void submit()}
        >
          {t("sharing.continue")}
        </Button>
      </View>
    </Dialog>
  );
}
