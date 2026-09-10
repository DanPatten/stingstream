import { t } from "i18next";
import { View, type ViewProps } from "react-native";
import { Text } from "@/components/common/Text";
import { useTheme } from "@/hooks/useTheme";
import { useDownload } from "@/providers/DownloadProvider";
import { JobStatus } from "@/providers/Downloads/types";
import { DownloadCard } from "./DownloadCard";

interface ActiveDownloadsProps extends ViewProps {}

export default function ActiveDownloads({ ...props }: ActiveDownloadsProps) {
  const { color } = useTheme();
  const { processes } = useDownload();

  // Filter out any invalid processes before rendering
  const validProcesses = processes?.filter((p) => p?.item?.Id) || [];

  if (validProcesses.length === 0)
    return (
      <View
        style={{ backgroundColor: color.bg["1"] }}
        {...props}
        className='p-4 rounded-2xl'
      >
        <Text className='text-lg font-bold'>
          {t("home.downloads.active_download")}
        </Text>
        <Text className='opacity-50'>
          {t("home.downloads.no_active_downloads")}
        </Text>
      </View>
    );

  return (
    <View
      style={{ backgroundColor: color.bg["1"] }}
      {...props}
      className='p-4 rounded-2xl'
    >
      <Text className='text-lg font-bold mb-2'>
        {t("home.downloads.active_downloads")}
      </Text>
      <View className='gap-y-2'>
        {validProcesses.map((p: JobStatus) => (
          <DownloadCard key={p.id} process={p} />
        ))}
      </View>
    </View>
  );
}
