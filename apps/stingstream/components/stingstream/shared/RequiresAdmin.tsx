import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { userAtom } from "@/providers/JellyfinProvider";
import { EmptyState } from "./ScreenState";

/**
 * Every StingStream.Core endpoint requires Jellyfin's `RequiresElevation`
 * policy (see any operation's `security` block in
 * packages/api-client/openapi.json), so these screens are administrator-only
 * — the same reasoning already applied to the Sessions button in
 * `app/(auth)/(tabs)/(home)/_layout.tsx`.
 */
export function useIsStingStreamAdmin(): boolean {
  const user = useAtomValue(userAtom);
  return !!user?.Policy?.IsAdministrator;
}

export function RequiresAdmin({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const isAdmin = useIsStingStreamAdmin();
  if (!isAdmin) {
    return (
      <EmptyState
        icon='user'
        title={t("admin.requires_admin_title")}
        detail={t("admin.requires_admin_detail")}
      />
    );
  }
  return <>{children}</>;
}

/**
 * The same gate, applied to a whole route file's default export.
 *
 * Hiding the row in Settings is the courtesy; this is the control, because a
 * URL can be pasted and `/settings/plugins/streamystats` is as reachable as the
 * screen that used to link to it.
 *
 * A wrapper rather than an early `return` inside each screen, for two reasons:
 * a screen whose body is one long `ScrollView` would need its JSX restructured
 * to hold a guard, and — the real one — a refused screen never mounts at all,
 * so none of its hooks run and none of its queries fire. An early return cannot
 * do that without breaking the rules of hooks.
 */
export function adminOnly<P extends object>(
  Screen: React.ComponentType<P>,
): React.FC<P> {
  const Guarded: React.FC<P> = (props) => (
    <RequiresAdmin>
      <Screen {...props} />
    </RequiresAdmin>
  );
  Guarded.displayName = `adminOnly(${Screen.displayName ?? Screen.name ?? "Screen"})`;
  return Guarded;
}
