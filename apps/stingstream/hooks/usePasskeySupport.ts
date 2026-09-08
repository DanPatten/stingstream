import { useEffect, useState } from "react";
import { useNodeContext } from "@/hooks/useNodeContext";
import {
  fetchPasskeySupport,
  type PasskeySupport,
} from "@/lib/stingstream/passkeysApi";
import { passkeysAvailableHere } from "@/lib/stingstream/webauthn";

/**
 * Whether to draw a passkey button at all.
 *
 * **Two things have to be true and they are asked in the cheap order.** This device has to have
 * WebAuthn — false on every native build and on any browser without it, and answerable with no
 * network at all — and the server has to have a domain to bind a credential to. Asking the device
 * first means a phone never makes the request.
 *
 * Anything unknown is "no". A button offering a sign-in method that cannot work is worse than no
 * button: it is pressed once, fails in the browser's own words, and teaches somebody that passkeys
 * are broken here.
 *
 * Returns `null` while the answer is still being fetched, so a caller can draw nothing rather than
 * flashing a button that is about to disappear.
 */
export function usePasskeySupport(): PasskeySupport | null {
  const nodeContext = useNodeContext();
  const [support, setSupport] = useState<PasskeySupport | null>(null);

  useEffect(() => {
    if (!passkeysAvailableHere() || !nodeContext) {
      setSupport({ supported: false, reason: null, relyingParty: null });
      return;
    }

    let cancelled = false;
    fetchPasskeySupport(nodeContext.origin)
      .then((answer) => {
        if (!cancelled) setSupport(answer);
      })
      .catch(() => {
        if (!cancelled) {
          setSupport({ supported: false, reason: null, relyingParty: null });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [nodeContext]);

  return support;
}
