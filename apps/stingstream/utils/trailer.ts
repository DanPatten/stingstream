/** Only known video hosts may become an embedded player URL. */
export function trailerEmbedUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.replace(/^www\./, "");
    const id =
      host === "youtu.be"
        ? url.pathname.slice(1)
        : ["youtube.com", "m.youtube.com", "youtube-nocookie.com"].includes(
              host,
            )
          ? (url.searchParams.get("v") ??
            url.pathname.match(/^\/(?:embed|shorts)\/([^/]+)/)?.[1])
          : null;
    return id && /^[\w-]{11}$/.test(id)
      ? `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&playsinline=1&rel=0`
      : null;
  } catch {
    return null;
  }
}
