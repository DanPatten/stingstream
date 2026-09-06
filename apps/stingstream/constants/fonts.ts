/**
 * Inter, on native.
 *
 * The four static faces are declared in `app.json`'s `expo-font` plugin block,
 * which copies them into the iOS and Android projects at prebuild — so on a
 * device they are already registered before any JavaScript runs and there is
 * nothing to do here. `fonts.web.ts` is the other half: the config plugin has
 * no web output at all (`node_modules/expo-font/plugin/build` ships an iOS and
 * an Android mod and no third), so the browser has to be handed the same four
 * files at runtime.
 *
 * Keeping the two apart is what stops the TTFs being bundled twice on native.
 *
 * The family names are the file basenames, which is also the PostScript name of
 * each face (`Inter-SemiBold` and friends) — the one string that resolves the
 * same way on all three platforms. See `constants/theme.tokens.json`.
 */
export const useInterFonts = (): boolean => true;
