export function TrailerPlayer({ url, title }: { url: string; title: string }) {
  return (
    <iframe
      src={url}
      title={title}
      allow='autoplay; encrypted-media; picture-in-picture; fullscreen'
      allowFullScreen
      referrerPolicy='strict-origin-when-cross-origin'
      style={{ width: "100%", aspectRatio: "16 / 9", border: 0 }}
    />
  );
}
