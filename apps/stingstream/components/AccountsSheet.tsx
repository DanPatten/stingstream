import { Ionicons } from "@expo/vector-icons";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Platform, TouchableOpacity, View } from "react-native";
import { Swipeable } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  SheetBackdrop,
  type SheetBackdropProps,
  SheetModal,
  type SheetModalRef,
  SheetView,
} from "@/components/common/Sheet";
import { confirmDestructive } from "@/components/stingstream/shared/confirm";
import { useTheme } from "@/hooks/useTheme";
import {
  deleteAccountCredential,
  type SavedServer,
  type SavedServerAccount,
} from "@/utils/secureCredentials";
import { Button } from "./Button";
import { Text } from "./common/Text";

interface AccountsSheetProps {
  open: boolean;
  setOpen: (open: boolean) => void;
  server: SavedServer | null;
  onAccountSelect: (account: SavedServerAccount) => void;
  onAddAccount: () => void;
  onAccountDeleted?: () => void;
}

export const AccountsSheet: React.FC<AccountsSheetProps> = ({
  open,
  setOpen,
  server,
  onAccountSelect,
  onAddAccount,
  onAccountDeleted,
}) => {
  const { color } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const bottomSheetModalRef = useRef<SheetModalRef>(null);

  const isAndroid = Platform.OS === "android";
  const snapPoints = useMemo(
    () => (isAndroid ? ["100%"] : ["50%"]),
    [isAndroid],
  );

  useEffect(() => {
    if (open) {
      bottomSheetModalRef.current?.present();
    } else {
      bottomSheetModalRef.current?.dismiss();
    }
  }, [open]);

  const handleSheetChanges = useCallback(
    (index: number) => {
      if (index === -1) {
        setOpen(false);
      }
    },
    [setOpen],
  );

  const renderBackdrop = useCallback(
    (props: SheetBackdropProps) => (
      <SheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />
    ),
    [],
  );

  const handleDeleteAccount = async (account: SavedServerAccount) => {
    if (!server) return;

    const ok = await confirmDestructive(
      t("server.remove_saved_login"),
      t("server.remove_account_description", { username: account.username }),
      t("common.remove"),
    );
    if (!ok) return;
    await deleteAccountCredential(server.address, account.userId);
    onAccountDeleted?.();
  };

  const getSecurityIcon = (
    securityType: SavedServerAccount["securityType"],
  ): keyof typeof Ionicons.glyphMap => {
    switch (securityType) {
      case "pin":
        return "keypad";
      case "password":
        return "lock-closed";
      default:
        return "key";
    }
  };

  const renderRightActions = (account: SavedServerAccount) => (
    <TouchableOpacity
      style={{ backgroundColor: color.state.danger }}
      onPress={() => handleDeleteAccount(account)}
      className='justify-center items-center px-5'
    >
      <Ionicons name='trash' size={20} color='white' />
    </TouchableOpacity>
  );

  if (!server) return null;

  return (
    <SheetModal
      ref={bottomSheetModalRef}
      snapPoints={snapPoints}
      onChange={handleSheetChanges}
      handleIndicatorStyle={{ backgroundColor: "white" }}
      backgroundStyle={{ backgroundColor: "#171717" }}
      backdropComponent={renderBackdrop}
    >
      <SheetView
        style={{
          flex: 1,
          paddingLeft: Math.max(16, insets.left),
          paddingRight: Math.max(16, insets.right),
          paddingBottom: Math.max(16, insets.bottom),
        }}
      >
        <View className='flex-1'>
          {/* Header */}
          <View className='mb-4'>
            <Text className='font-bold text-2xl'>
              {t("server.select_account")}
            </Text>
            <Text tone='secondary' className='mt-1'>
              {server.name || server.address}
            </Text>
          </View>

          {/* Account List */}
          <View
            style={{ backgroundColor: color.bg["2"] }}
            className='rounded-xl overflow-hidden mb-4'
          >
            {server.accounts.map((account, index) => (
              <Swipeable
                key={account.userId}
                renderRightActions={() => renderRightActions(account)}
                overshootRight={false}
              >
                <TouchableOpacity
                  onPress={() => {
                    setOpen(false);
                    onAccountSelect(account);
                  }}
                  style={{
                    backgroundColor: color.bg["2"],
                    borderBottomColor: color.border.strong,
                  }}
                  className={`flex-row items-center p-4 ${
                    index < server.accounts.length - 1 ? "border-b" : ""
                  }`}
                >
                  {/* Avatar */}
                  <View
                    style={{ backgroundColor: color.bg["3"] }}
                    className='w-10 h-10 rounded-full items-center justify-center mr-3'
                  >
                    <Ionicons name='person' size={20} color='white' />
                  </View>

                  {/* Account Info */}
                  <View className='flex-1'>
                    <Text className='font-medium'>{account.username}</Text>
                    <Text tone='tertiary' className='text-sm'>
                      {account.securityType === "none"
                        ? t("save_account.no_protection")
                        : account.securityType === "pin"
                          ? t("save_account.pin_code")
                          : t("save_account.password")}
                    </Text>
                  </View>

                  {/* Security Icon */}
                  <Ionicons
                    name={getSecurityIcon(account.securityType)}
                    size={18}
                    color={color.accent[500]}
                  />
                </TouchableOpacity>
              </Swipeable>
            ))}
          </View>

          {/* Hint */}
          <Text tone='tertiary' className='text-xs mb-4 ml-1'>
            {t("server.swipe_to_remove")}
          </Text>

          {/* Add Account Button */}
          <Button
            onPress={() => {
              setOpen(false);
              onAddAccount();
            }}
            color='purple'
          >
            <View className='flex-row items-center justify-center'>
              <Ionicons name='add' size={20} color='white' />
              <Text className='font-semibold ml-2'>
                {t("server.add_account")}
              </Text>
            </View>
          </Button>
        </View>
      </SheetView>
    </SheetModal>
  );
};
