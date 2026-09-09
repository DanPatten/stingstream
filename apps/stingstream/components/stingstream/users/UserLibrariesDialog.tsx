import type { UserDto } from "@jellyfin/sdk/lib/generated-client/models";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { toast } from "sonner-native";
import { Dialog } from "@/components/common/Dialog";
import { FormError } from "@/components/common/FormError";
import { Text } from "@/components/common/Text";
import { useInviteLibraries } from "@/lib/stingstream/invites";
import { useSetUserLibraries } from "@/lib/stingstream/serverUsers";
import { LibraryPicker } from "../shared/LibraryPicker";
import { policyForSelection, selectionForPolicy } from "./userAccess";

/**
 * "What can this person watch?", asked of an account that already exists.
 *
 * The same control as the invite form, deliberately: somebody who has invited a
 * person once already knows this. What differs is where it starts.
 *
 * **It is seeded from the truth, not from a default.** `useChosenLibraries`
 * ticks everything, which is right for a new share and wrong here — its own
 * doc-comment says a picker showing what is already stored "must show the
 * truth", and pre-ticking would claim access nobody granted.
 *
 * **Nothing ticked is allowed.** Minting refuses it, because a live link to an
 * account that can see nothing looks like a bug on the other end. This is an
 * edit to an account that exists, and taking access away is a thing an owner
 * does on purpose.
 */
export const UserLibrariesDialog: React.FC<{
  user: UserDto | null;
  onClose: () => void;
}> = ({ user, onClose }) => {
  const { t } = useTranslation();
  const libraries = useInviteLibraries();
  const save = useSetUserLibraries();

  const available = useMemo(() => libraries.data ?? [], [libraries.data]);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Re-seeded whenever the dialog opens on somebody, and again if the library
  // list lands after it. Keyed on the account rather than on `visible` so
  // reopening the same row cannot show the previous row's ticks for a frame.
  useEffect(() => {
    setError(null);
    setSelected(user ? selectionForPolicy(user.Policy, available) : []);
  }, [user, available]);

  const isAdmin = Boolean(user?.Policy?.IsAdministrator);

  const submit = () => {
    if (!user?.Id || !user.Policy) return;
    setError(null);
    save.mutate(
      {
        userId: user.Id,
        policy: policyForSelection(user.Policy, selected, available),
      },
      {
        onSuccess: () => {
          toast.success(t("users.libraries_saved"));
          onClose();
        },
        onError: (e) => setError(e.message),
      },
    );
  };

  return (
    <Dialog
      visible={!!user}
      onClose={onClose}
      title={user?.Name ?? t("users.unnamed")}
      description={isAdmin ? undefined : t("users.libraries_description")}
      actions={
        isAdmin
          ? [{ label: t("common.close"), onPress: onClose }]
          : [
              { label: t("common.cancel"), onPress: onClose },
              {
                label: t("users.libraries_save"),
                testID: "user-libraries-save",
                onPress: submit,
                loading: save.isPending,
                disabled: save.isPending,
              },
            ]
      }
    >
      {/* An administrator sees every library whatever the policy says — Jellyfin
          checks `IsAdministrator` before it checks folders — so a picker here
          would be a set of boxes that change nothing. */}
      {isAdmin ? (
        <Text variant='body' tone='secondary'>
          {t("users.libraries_administrator")}
        </Text>
      ) : (
        <View testID='user-libraries'>
          <LibraryPicker
            available={available}
            selected={selected}
            onToggle={(id) =>
              setSelected((current) =>
                current.includes(id)
                  ? current.filter((existing) => existing !== id)
                  : [...current, id],
              )
            }
            loading={libraries.isPending}
            disabled={save.isPending}
          />
          <FormError message={error} />
        </View>
      )}
    </Dialog>
  );
};
