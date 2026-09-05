/**
 * Browser polyfills applied before the app entry (StingStream M2 web target).
 *
 * Imported only from `index.web.ts`, so native entry points are untouched.
 * Everything here exists because `react-native-web` implements a subset of a
 * React Native API that app code calls unconditionally; patching the shim once,
 * up front, keeps the call sites identical across platforms.
 */

import { Appearance } from "react-native";

/**
 * `app/_layout.tsx` pins the app to dark with `Appearance.setColorScheme("dark")`.
 * react-native-web's `Appearance` is read-only (it only proxies
 * `prefers-color-scheme`), so the call throws and takes down the root layout.
 *
 * The polyfill makes it a real setter: it records the forced scheme, notifies
 * `Appearance.addChangeListener` subscribers, and reflects the choice onto the
 * document (`color-scheme` + a `data-theme` attribute) so browser UI — form
 * controls, scrollbars — matches the app chrome.
 */
const patchAppearance = () => {
  const appearance = Appearance as unknown as {
    setColorScheme?: (scheme: "light" | "dark" | null) => void;
    getColorScheme?: () => "light" | "dark" | null;
    addChangeListener?: (listener: (prefs: any) => void) => any;
  };

  if (typeof appearance.setColorScheme === "function") return;

  let forced: "light" | "dark" | null = null;
  const listeners = new Set<(prefs: any) => void>();

  const originalGet = appearance.getColorScheme?.bind(appearance);
  const originalAdd = appearance.addChangeListener?.bind(appearance);

  appearance.getColorScheme = () => forced ?? originalGet?.() ?? "light";

  appearance.addChangeListener = (listener) => {
    listeners.add(listener);
    const inner = originalAdd?.(listener);
    return {
      remove: () => {
        listeners.delete(listener);
        inner?.remove?.();
      },
    };
  };

  appearance.setColorScheme = (scheme) => {
    forced = scheme;
    if (typeof document !== "undefined") {
      const root = document.documentElement;
      if (scheme) {
        root.style.colorScheme = scheme;
        root.setAttribute("data-theme", scheme);
      } else {
        root.style.removeProperty("color-scheme");
        root.removeAttribute("data-theme");
      }
    }
    for (const listener of listeners) {
      listener({ colorScheme: appearance.getColorScheme?.() ?? null });
    }
  };
};

patchAppearance();
