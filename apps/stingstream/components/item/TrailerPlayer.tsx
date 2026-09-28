import { WebView } from "react-native-webview";

export function TrailerPlayer({ url, title }: { url: string; title: string }) {
  return (
    <WebView
      source={{ uri: url, headers: { Referer: "https://org.stingstream.app" } }}
      accessibilityLabel={title}
      allowsFullscreenVideo
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      style={{ width: "100%", aspectRatio: 16 / 9 }}
    />
  );
}
