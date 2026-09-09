import { Image as ExpoImage, type ImagePrefetchOptions } from "expo-image";

/**
 * The app's `<Image>`.
 *
 * It used to be a wrapper that attached the custom proxy auth headers
 * configured for the server an image was hosted on. That feature is gone, so
 * this is expo-image's own `Image` under the name the ~50 call sites already
 * import. Kept as one name rather than rewritten across every screen: the
 * indirection costs nothing and "the image came from the server" is still what
 * these call sites mean.
 */
export const Image = ExpoImage;

/**
 * `Image.prefetch` for one URL, with a cache policy.
 *
 * Thin for the same reason: it used to resolve headers per URL, which plain
 * expo-image could not do.
 */
export async function prefetchServerImage(
  uri: string,
  cachePolicy: ImagePrefetchOptions["cachePolicy"] = "memory-disk",
): Promise<boolean> {
  return ExpoImage.prefetch(uri, { cachePolicy });
}
