import { Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { EmptyState } from "@/components/common/EmptyState";
import { PageContainer } from "@/components/common/PageContainer";
import { useAppRouter } from "@/hooks/useAppRouter";

/**
 * A route inside `(auth)` that does not exist.
 *
 * **Why this is separate from `app/+not-found.tsx`**, which already existed: that one lives
 * *outside* every route group, so `useProtectedRoute` (`providers/JellyfinProvider.tsx`) sees
 * `segments[0] === "+not-found"`, decides a signed-in user is outside `(auth)`, and immediately
 * `router.replace`s them to Home. The 404 is mounted for a frame and then gone.
 *
 * That turned every in-app path typo into a silent, plausible-looking navigation to the wrong
 * screen. It hid a real one for weeks: tapping a share pushed `/settings/groups/<id>/page`, a
 * route that had been renamed to `index.tsx`, and the only symptom anyone could describe was
 * *"clicking on an existing share doesn't work, it takes me to the homepage"*.
 *
 * This file is inside `(auth)`, so the guard leaves it alone and a bad link says what it is.
 */
export default function AuthNotFoundScreen() {
  const { t } = useTranslation();
  const router = useAppRouter();

  return (
    <>
      <Stack.Screen options={{ title: t("not_found.title") }} />
      <PageContainer width='settings'>
        <View style={{ paddingVertical: 48 }}>
          <EmptyState
            icon='close'
            title={t("not_found.title")}
            detail={t("not_found.detail")}
            action={{
              label: t("not_found.go_home"),
              icon: "home",
              onPress: () => router.replace("/(auth)/(tabs)/(home)/"),
            }}
          />
        </View>
      </PageContainer>
    </>
  );
}
