import { useAtomValue } from "jotai";
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
  const isAdmin = useIsStingStreamAdmin();
  if (!isAdmin) {
    return (
      <EmptyState
        title='Administrators only'
        detail='This server manages the movie manager, the series manager and downloads under your admin account — sign in as an administrator to use it.'
      />
    );
  }
  return <>{children}</>;
}
