import { View } from "react-native";
import { Image } from "@/components/common/ServerImage";
import { useTheme } from "@/hooks/useTheme";

type PosterProps = {
  id?: string | null;
  url?: string | null;
  showProgress?: boolean;
  blurhash?: string | null;
};

const Poster: React.FC<PosterProps> = ({ id, url, blurhash }) => {
  const { color } = useTheme();
  if (!id && !url)
    return (
      <View
        className='border'
        style={{
          aspectRatio: "10/15",
          borderColor: color.border.subtle,
        }}
      />
    );

  return (
    <View
      style={{ borderColor: color.border.subtle }}
      className='rounded-lg overflow-hidden border'
    >
      <Image
        placeholder={
          blurhash
            ? {
                blurhash,
              }
            : null
        }
        key={id}
        id={id!}
        source={
          url
            ? {
                uri: url,
              }
            : null
        }
        cachePolicy={"memory-disk"}
        contentFit='cover'
        style={{
          aspectRatio: "10/15",
        }}
      />
    </View>
  );
};

export default Poster;
