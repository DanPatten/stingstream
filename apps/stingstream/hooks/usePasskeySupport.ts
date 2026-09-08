import { useEffect, useState } from "react";
import { fetchPasskeySupport } from "@/lib/stingstream/accountsApi";
import { passkeysAvailableHere } from "@/lib/stingstream/webauthn";

export interface PasskeyAvailability {
  /** Both halves said yes: this device can do passkeys and so can the service. */
  usable: boolean;
  /** Why not, when the **service** is the half that said no. Worth showing in settings. */
  reason: string | null;
}

/**
 * Whether a passkey button should exist at all.
 *
 * Two independent questions, and both have to be yes:
 *
 * - **Can this device?** False on every native build and on any browser without WebAuthn. Answered
 *   locally, with no round trip, which is why it is checked first.
 * - **Can this service?** The `passkeys` Cargo feature may not be compiled in, or the service may
 *   have no origin configured — a passkey is bound to one for its whole life, so a service without
 *   one runs with passkeys off rather than guessing.
 *
 * Both are ordinary answers rather than errors, and both resolve to the same behaviour: draw
 * nothing, and let the person use their password. Offering a sign-in method that cannot work is
 * worse than not offering it, so this is asked before a button is drawn rather than after it is
 * pressed.
 *
 * Plain `useEffect` rather than React Query, like `useLoginNodeAccount`: this runs on the login
 * screen, before any session exists, where the query client's auth-gated hooks do not.
 */
export function usePasskeySupport(service: string | null): PasskeyAvailability {
  const [state, setState] = useState<PasskeyAvailability>({
    usable: false,
    reason: null,
  });

  useEffect(() => {
    if (!service || !passkeysAvailableHere()) {
      setState({ usable: false, reason: null });
      return;
    }
    let cancelled = false;
    void fetchPasskeySupport(service).then((support) => {
      if (cancelled) return;
      setState({
        usable: support.supported,
        reason: support.supported ? null : (support.reason ?? null),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [service]);

  return state;
}
