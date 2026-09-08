import { getStingStreamApiBaseUrl } from "@stingstream/api-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { usePasskeySupport } from "@/hooks/usePasskeySupport";
import {
  deletePasskey,
  fetchPasskeys,
  registerPasskey,
} from "@/lib/stingstream/passkeysApi";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";

const PASSKEYS_QUERY_KEY = ["stingstream", "passkeys"] as const;

/**
 * Passkeys on this account, under Settings → Account.
 *
 * Drawn only when this browser and this server can both do one, so somebody on a phone or on a
 * server with no domain never sees a section they cannot use. That is the whole of the "optional"
 * promise: a password is the credential, a passkey is a shortcut, and the absence of this section
 * is an ordinary state rather than something missing.
 *
 * The section still appears with no passkeys registered, because "add one" is the thing somebody
 * came here to do.
 */
export function PasskeysSection({ className }: { className?: string }) {
  const { t } = useTranslation();
  const support = usePasskeySupport();
  const api = useAtomValue(apiAtom);
  const user = useAtomValue(userAtom);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const base = api?.basePath ? getStingStreamApiBaseUrl(api.basePath) : null;
  const token = api?.accessToken ?? null;

  const passkeys = useQuery({
    queryKey: [...PASSKEYS_QUERY_KEY, base],
    queryFn: () => fetchPasskeys(base!, token),
    enabled: !!base && !!user?.Id && support?.supported === true,
  });

  const add = useCallback(async () => {
    if (!base || busy) return;
    setBusy(true);
    try {
      // False means the person dismissed the browser's prompt. Nothing to report: they changed
      // their mind, and a red toast for that reads as a failure they have to understand.
      const added = await registerPasskey(
        base,
        t("passkeys.default_label"),
        token,
      );
      if (added) {
        toast.success(t("passkeys.added"));
        await queryClient.invalidateQueries({ queryKey: PASSKEYS_QUERY_KEY });
      }
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : t("passkeys.error_register"),
      );
    } finally {
      setBusy(false);
    }
  }, [base, busy, queryClient, t, token]);

  const remove = useCallback(
    async (id: string) => {
      if (!base) return;
      try {
        await deletePasskey(base, id, token);
        toast.success(t("passkeys.removed"));
        await queryClient.invalidateQueries({ queryKey: PASSKEYS_QUERY_KEY });
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : t("passkeys.error_remove"),
        );
      }
    },
    [base, queryClient, t, token],
  );

  if (support?.supported !== true) return null;

  const rows = passkeys.data ?? [];

  return (
    <View className={className}>
      <ListGroup title={t("passkeys.title")}>
        {rows.map((passkey) => (
          <ListItem
            key={passkey.id}
            title={passkey.label}
            subtitle={
              passkey.usable
                ? t("passkeys.row_added", {
                    date: new Date(passkey.createdAt).toLocaleDateString(),
                  })
                : // The one failure mode worth explaining rather than hiding: a passkey is bound to
                  // the domain it was made on, so changing the server's address strands the old
                  // ones. Without this line it reads as "my passkey stopped working".
                  t("passkeys.row_other_domain", {
                    domain: passkey.relyingParty,
                  })
            }
            subtitleColor={passkey.usable ? "default" : "red"}
            iconAfter={
              <Button
                variant='ghost'
                size='sm'
                icon='delete'
                onPress={() => void remove(passkey.id)}
                accessibilityLabel={t("passkeys.remove")}
              >
                {""}
              </Button>
            }
          />
        ))}
      </ListGroup>

      <Text variant='caption' tone='tertiary' style={{ marginTop: 8 }}>
        {rows.length === 0
          ? t("passkeys.empty_detail", { domain: support.relyingParty ?? "" })
          : t("passkeys.detail")}
      </Text>

      <Button
        variant='secondary'
        icon='add'
        onPress={() => void add()}
        loading={busy}
        disabled={busy}
        testID='settings-add-passkey'
        style={{ marginTop: 12 }}
      >
        {t("passkeys.add")}
      </Button>
    </View>
  );
}
