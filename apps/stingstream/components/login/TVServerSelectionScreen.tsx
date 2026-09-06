import { t } from "i18next";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { useMMKVString } from "react-native-mmkv";
import { StingStreamWordmark } from "@/components/brand";
import { Text } from "@/components/common/Text";
import { useScaledTVTypography } from "@/constants/TVTypography";
import { useJellyfinDiscovery } from "@/hooks/useJellyfinDiscovery";
import { checkJellyfinServer } from "@/utils/jellyfin/checkServer";
import { scaleSize } from "@/utils/scaleSize";
import type { SavedServer } from "@/utils/secureCredentials";
import { nodeCandidates } from "@/utils/serverUrl/nodeCandidates";
import { TVAddIcon } from "./TVAddIcon";
import { TVServerIcon } from "./TVServerIcon";

interface FoundServer {
  url: string;
  name: string;
}

interface TVServerSelectionScreenProps {
  onServerSelect: (server: SavedServer) => void;
  onAddServer: () => void;
  /** A server found on the network (or typed manually elsewhere) that just answered the probe. */
  onConnect: (url: string) => void;
  onDeleteServer: (server: SavedServer) => void;
  disabled?: boolean;
}

export const TVServerSelectionScreen: React.FC<
  TVServerSelectionScreenProps
> = ({
  onServerSelect,
  onAddServer,
  onConnect,
  onDeleteServer,
  disabled = false,
}) => {
  const typography = useScaledTVTypography();
  const [_previousServers] = useMMKVString("previousServers");
  const { servers: discoveredServers, startDiscovery } = useJellyfinDiscovery();
  const [foundServers, setFoundServers] = useState<FoundServer[]>([]);
  const probedAddresses = useRef(new Set<string>());

  const previousServers = useMemo(() => {
    try {
      return JSON.parse(_previousServers || "[]") as SavedServer[];
    } catch {
      return [];
    }
  }, [_previousServers]);

  const hasServers = previousServers.length > 0;

  // A returning user with saved servers goes straight to their icons; only a
  // fresh TV (or one with every server removed) spends the 5 s listening for
  // a UDP discovery reply.
  useEffect(() => {
    if (hasServers) return;
    return startDiscovery();
  }, [hasServers, startDiscovery]);

  // Probe every discovery hit as it arrives. A UDP broadcast answers with
  // whatever port the embedded Jellyfin itself is listening on, not the
  // gateway's -- nodeCandidates expands each hit into the gateway address
  // first, the literal discovered address second, and the first one that is
  // actually a (StingStream-hosted) Jellyfin wins.
  useEffect(() => {
    if (hasServers) return;
    for (const hit of discoveredServers) {
      if (probedAddresses.current.has(hit.address)) continue;
      probedAddresses.current.add(hit.address);

      (async () => {
        for (const candidate of nodeCandidates(hit.address)) {
          try {
            const result = await checkJellyfinServer(candidate);
            if (result) {
              setFoundServers((prev) =>
                prev.some((server) => server.url === result.url)
                  ? prev
                  : [
                      ...prev,
                      {
                        url: result.url,
                        name: result.name || hit.serverName || "",
                      },
                    ],
              );
              return;
            }
          } catch {
            // This candidate answered but was not usable (too old, or not
            // Jellyfin at all) -- try the next one before giving up on the hit.
          }
        }
      })();
    }
  }, [discoveredServers, hasServers]);

  const handleDeleteServer = (server: SavedServer) => {
    Alert.alert(
      t("server.remove_server"),
      t("server.remove_server_description", {
        server: server.name || server.address,
      }),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("common.delete"),
          style: "destructive",
          onPress: () => onDeleteServer(server),
        },
      ],
    );
  };

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{
        flexGrow: 1,
        justifyContent: "center",
        alignItems: "center",
        paddingVertical: scaleSize(60),
      }}
      showsVerticalScrollIndicator={false}
    >
      <View
        style={{
          width: "100%",
          alignItems: "center",
          paddingHorizontal: scaleSize(60),
        }}
      >
        {/* Wordmark */}
        <View style={{ alignItems: "center", marginBottom: scaleSize(16) }}>
          <StingStreamWordmark height={scaleSize(64)} />
        </View>

        <Text
          style={{
            fontSize: typography.body,
            color: "#9CA3AF",
            textAlign: "center",
            marginBottom: scaleSize(48),
          }}
        >
          {hasServers
            ? t("server.select_your_server")
            : t("server.add_server_to_get_started")}
        </Text>

        {hasServers ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{
              paddingHorizontal: scaleSize(20),
              gap: scaleSize(24),
            }}
            style={{ overflow: "visible" }}
          >
            {previousServers.map((server, index) => (
              <TVServerIcon
                key={server.address}
                name={server.name || ""}
                address={server.address}
                onPress={() => onServerSelect(server)}
                onLongPress={() => handleDeleteServer(server)}
                hasTVPreferredFocus={index === 0}
                disabled={disabled}
              />
            ))}

            <TVAddIcon
              label={t("server.enter_address")}
              onPress={onAddServer}
              disabled={disabled}
            />
          </ScrollView>
        ) : (
          <View style={{ width: "100%", alignItems: "center" }}>
            {foundServers.length > 0 && (
              <View style={{ width: "100%", marginBottom: scaleSize(32) }}>
                <Text
                  style={{
                    fontSize: typography.callout,
                    color: "#9CA3AF",
                    textAlign: "center",
                    marginBottom: scaleSize(16),
                  }}
                >
                  {t("server.found_on_network")}
                </Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{
                    paddingHorizontal: scaleSize(20),
                    gap: scaleSize(24),
                  }}
                  style={{ overflow: "visible" }}
                >
                  {foundServers.map((server) => (
                    <TVServerIcon
                      key={server.url}
                      name={server.name}
                      address={server.url}
                      onPress={() => onConnect(server.url)}
                      disabled={disabled}
                    />
                  ))}
                </ScrollView>
              </View>
            )}

            {/* Enter an address manually. Kept as the one stable preferred-focus
                target on this branch: found servers stream in asynchronously over
                up to 5 s, and moving focus onto them the moment they appear would
                be the flicker docs/tv-focus-guide.md warns about. */}
            <TVAddIcon
              label={t("server.enter_address")}
              onPress={onAddServer}
              hasTVPreferredFocus
              disabled={disabled}
            />
          </View>
        )}
      </View>
    </ScrollView>
  );
};
