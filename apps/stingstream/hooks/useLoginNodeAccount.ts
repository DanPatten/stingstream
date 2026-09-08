import { useEffect, useState } from "react";
import {
  fetchLoginNodeAccount,
  type LoginNodeAccount,
} from "@/lib/stingstream/accountsApi";

/**
 * Whether the server serving this page has a StingStream account.
 *
 * Deliberately not React Query: this runs on the login screen, before there is a session or an
 * `apiAtom`, and every query hook in the app is gated on being signed in. One fetch, once.
 *
 * `null` while it is in flight and whenever there is no server — the sign-in form does not wait for
 * it, because a local sign-in is always valid and making somebody watch a spinner to find out
 * whether a service exists would be worse than the round trip it saves.
 */
export function useLoginNodeAccount(
  serverOrigin: string | null,
): LoginNodeAccount | null {
  const [account, setAccount] = useState<LoginNodeAccount | null>(null);

  useEffect(() => {
    if (!serverOrigin) {
      setAccount(null);
      return;
    }
    let cancelled = false;
    void fetchLoginNodeAccount(serverOrigin).then((value) => {
      if (!cancelled) setAccount(value);
    });
    return () => {
      cancelled = true;
    };
  }, [serverOrigin]);

  return account;
}
