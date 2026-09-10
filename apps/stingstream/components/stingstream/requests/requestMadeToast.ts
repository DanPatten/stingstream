import type { TFunction } from "i18next";
import { toast } from "sonner-native";
import { type MemberRequest, requestTitle } from "@/lib/stingstream/requests";

/**
 * What to say once the node has answered a new request.
 *
 * Three genuinely different outcomes, and calling all of them "requested" would hide the one that
 * matters: a title the group already had starts no download at all.
 *
 * Shared because a request is now made from two places. A movie is requested straight from its row
 * in Find, and a TV show from the sheet that asks which seasons — and the two must not drift into
 * describing the same answer differently.
 */
export function requestMadeToast(made: MemberRequest, t: TFunction) {
  const title = requestTitle(made);
  if (made.state === "available") {
    toast.success(t("requests.toast_available", { title }));
    return;
  }
  if (made.state === "pending") {
    toast.success(t("requests.toast_pending", { title }));
    return;
  }
  toast.success(t("requests.toast_requested", { title }));
}
