import { Platform } from "react-native";
import { isHeroCarouselAvailable } from "./hero-carousel";

/**
 * Whether the home screen has a hero to show — on any platform, by any means.
 *
 * `isHeroCarouselAvailable()` answers a narrower question: is the *native*
 * paged view in this binary. That was the same question until WP4, because the
 * native view was the only hero there was; on web it answered "no", which is
 * why v0.1.0's browser home opened straight onto a row of 118 px posters and
 * why the Appearance switch for the hero was invisible there.
 *
 * `components/home/HeroSpotlight.tsx` is a React Native hero that runs
 * anywhere, so the honest answer now is "yes" on web and Android, and "does
 * the binary have the native view" everywhere else. Television is excluded on
 * purpose: `components/home/Home.tv.tsx` has its own `TVHeroCarousel`, driven
 * by focus rather than by paging, and neither of these heroes belongs there.
 *
 * Read this — not `isHeroCarouselAvailable` — anywhere the question is "should
 * a hero exist here": the home screen, and the Appearance setting that turns
 * it off.
 */
export const isHeroAvailable = (): boolean => {
  if (Platform.isTV) return false;
  if (Platform.OS === "web" || Platform.OS === "android") return true;
  return isHeroCarouselAvailable();
};
