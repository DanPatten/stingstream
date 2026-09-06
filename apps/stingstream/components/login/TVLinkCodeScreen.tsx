import { t } from "i18next";
import React, { useCallback, useEffect, useRef } from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";
import { StingStreamWordmark } from "@/components/brand";
import { Text } from "@/components/common/Text";
import { TVButton } from "@/components/tv/TVButton";
import { useScaledTVTypography } from "@/constants/TVTypography";
import { useTVBackPress } from "@/hooks/useTVBackPress";
import { useJellyfin } from "@/providers/JellyfinProvider";
import { scaleSize } from "@/utils/scaleSize";

interface TVLinkCodeScreenProps {
  serverName: string;
  onSignInWithPassword: () => void;
  onChangeServer: () => void;
  /** The server has code sign-in turned off, or asking for a code otherwise failed. */
  onUnavailable: () => void;
  disabled?: boolean;
}

/**
 * Plex-style code-first TV sign-in: request a code on mount, show it large,
 * and let the 1 s poll in `JellyfinProvider` log the user in the moment it is
 * entered elsewhere. A code that times out is regenerated automatically by
 * the provider (see `pollQuickConnect`'s 400 branch) -- this screen only
 * ever shows whatever code is current.
 */
export const TVLinkCodeScreen: React.FC<TVLinkCodeScreenProps> = ({
  serverName,
  onSignInWithPassword,
  onChangeServer,
  onUnavailable,
  disabled = false,
}) => {
  const typography = useScaledTVTypography();
  const {
    initiateQuickConnect,
    quickConnectStatus,
    quickConnectCode,
    saveCurrentAccount,
  } = useJellyfin();

  // Ask for a code exactly once per mount -- effects can re-run (fast
  // refresh, a parent re-render), and re-requesting a code every time would
  // spin a fresh one under the user while they are reading the current one.
  const requestedRef = useRef(false);
  useEffect(() => {
    if (requestedRef.current) return;
    requestedRef.current = true;
    initiateQuickConnect().catch(() => {
      // Most commonly: Quick Connect is turned off on this server. Password
      // sign-in still works, so fall through to it rather than dead-ending
      // on a code that will never arrive.
      onUnavailable();
    });
  }, [initiateQuickConnect, onUnavailable]);

  // A TV is a household device: once a code sign-in succeeds, save the
  // account with no PIN or password rather than showing the save-account
  // picker a manually typed login gets. PIN protection can still be added
  // later from the account itself.
  useEffect(() => {
    if (quickConnectStatus !== "authorized") return;
    saveCurrentAccount({ securityType: "none", serverName }).catch(() => {
      // Best effort: the sign-in already succeeded either way.
    });
  }, [quickConnectStatus, saveCurrentAccount, serverName]);

  const handleBack = useCallback(() => {
    if (disabled) return false;
    onChangeServer();
    return true;
  }, [disabled, onChangeServer]);

  useTVBackPress(() => handleBack(), [handleBack]);

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
          maxWidth: 900,
          alignItems: "center",
          paddingHorizontal: scaleSize(60),
        }}
      >
        <StingStreamWordmark height={scaleSize(48)} />

        <Text
          style={{
            fontSize: typography.heading,
            fontWeight: "bold",
            color: "#FFFFFF",
            textAlign: "center",
            marginTop: scaleSize(32),
          }}
        >
          {t("login.sign_in_with_code")}
        </Text>

        {!!serverName && (
          <Text
            style={{
              fontSize: typography.body,
              color: "#9CA3AF",
              textAlign: "center",
              marginTop: scaleSize(8),
            }}
          >
            {serverName}
          </Text>
        )}

        <View
          style={{
            marginTop: scaleSize(40),
            marginBottom: scaleSize(32),
            paddingHorizontal: scaleSize(48),
            paddingVertical: scaleSize(32),
            borderRadius: scaleSize(24),
            backgroundColor: "rgba(255, 255, 255, 0.05)",
          }}
        >
          <Text
            style={{
              fontSize: typography.display,
              fontWeight: "bold",
              color: "#FFFFFF",
              letterSpacing: scaleSize(16),
            }}
          >
            {quickConnectCode || "––––––"}
          </Text>
        </View>

        <Text
          style={{
            fontSize: typography.body,
            color: "#D1D5DB",
            textAlign: "center",
            maxWidth: scaleSize(720),
            marginBottom: scaleSize(24),
          }}
        >
          {t("login.link_code_instructions")}
        </Text>

        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: scaleSize(12),
            marginBottom: scaleSize(48),
          }}
        >
          <ActivityIndicator color='#9CA3AF' />
          <Text style={{ fontSize: typography.callout, color: "#9CA3AF" }}>
            {t("login.link_code_waiting")}
          </Text>
        </View>

        <View style={{ flexDirection: "row", gap: scaleSize(24) }}>
          <TVButton
            onPress={onSignInWithPassword}
            variant='glass'
            disabled={disabled}
            hasTVPreferredFocus
            style={{ width: scaleSize(340) }}
          >
            <Text
              style={{
                fontSize: typography.callout,
                fontWeight: "600",
                color: "#FFFFFF",
              }}
            >
              {t("login.sign_in_with_password")}
            </Text>
          </TVButton>
          <TVButton
            onPress={onChangeServer}
            variant='glass'
            disabled={disabled}
            style={{ width: scaleSize(340) }}
          >
            <Text
              style={{
                fontSize: typography.callout,
                fontWeight: "600",
                color: "#FFFFFF",
              }}
            >
              {t("server.change_server")}
            </Text>
          </TVButton>
        </View>
      </View>
    </ScrollView>
  );
};
