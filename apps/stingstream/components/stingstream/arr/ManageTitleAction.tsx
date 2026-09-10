import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/Button";
import { useArrTitle } from "@/lib/stingstream/hooks";
import {
  type MemberRequest,
  requestTitle,
  useCanApproveRequests,
} from "@/lib/stingstream/requests";
import { ManageTitleSheet } from "./ManageTitleSheet";

/**
 * The manage actions, offered from a request rather than from the title's own page.
 *
 * A film's page carries these — monitoring, quality profile, remove — but a film only *has* a page
 * once a file has landed. Between "asked for" and "arrived" the title exists in the manager and
 * nowhere the app can point at, which is exactly the window in which somebody notices they asked
 * for the wrong thing. Withdrawing the request does not help: `DELETE /requests/{id}` drops the
 * row and leaves the manager tracking the title, by design, because the node grabbing it may not
 * be this one.
 *
 * So the request row carries the same sheet for as long as it is the only handle on the title.
 * It draws nothing at all unless this node's manager actually tracks it, which is the honest
 * answer for a request another node is fulfilling, one still waiting for approval, and one whose
 * title is already in the library with a page of its own.
 *
 * Administrator-only, like every endpoint behind it.
 */
export function ManageTitleAction({ request }: { request: MemberRequest }) {
  const { t } = useTranslation();
  const isAdmin = useCanApproveRequests();
  const [open, setOpen] = useState(false);

  const isMovie = request.kind !== "series";
  const providerId = request.providerId;
  const managed = useArrTitle(
    isMovie ? "movie" : "series",
    providerId || undefined,
    isAdmin,
  );

  if (!managed.row || !providerId) return null;

  return (
    <>
      <Button
        variant='secondary'
        size='sm'
        icon='settings'
        onPress={() => setOpen(true)}
      >
        {t("item.manage_title")}
      </Button>
      <ManageTitleSheet
        kind={isMovie ? "movie" : "series"}
        providerId={providerId}
        title={requestTitle(request)}
        monitored={managed.row.monitored ?? false}
        visible={open}
        onClose={() => setOpen(false)}
        // Nothing to navigate away from: the request row this hangs off is a list item, and the
        // list refreshes itself off the mutation's invalidation.
        onRemovedWithFiles={() => {}}
      />
    </>
  );
}
