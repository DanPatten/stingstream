import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { TabsBar } from "@/components/common/Tabs";
import { RequestPolicySection } from "@/components/stingstream/requests/RequestPolicySection";
import { UsersScreen } from "@/components/stingstream/users/UsersScreen";
import { space } from "@/constants/theme";
import { FocusTarget } from "../FocusTarget";
import { SettingsPane } from "./SettingsPane";

type Section = "people" | "policy";

const SECTIONS: Section[] = ["people", "policy"];

/**
 * A section name from the URL, or the first one.
 *
 * Narrowed rather than cast, the same guard the old Admin screen used: the value
 * arrives from a query string, and a screen that trusted it would render
 * nothing at all for a typo — every branch missing, a blank page under a tab
 * bar. It is also how the redirects from the pages this replaced land on the
 * right section, and how the settings search jumps to one.
 */
export const sectionFromParam = (value: string | undefined): Section =>
  SECTIONS.find((s) => s === value) ?? "people";

/**
 * Who can get in, what each of them may watch, and how much they may ask for.
 *
 * The three answers used to live in three places: the accounts and the
 * invitations on a `/users` section of their own, and how many requests a week
 * somebody may make as the *Policy* tab of the Requests screen. They are one
 * question — what is this person allowed to do here — and putting the quota
 * beside the account it applies to is the whole point of gathering them.
 *
 * Requests keeps its Approvals and Activity sections: approving a specific
 * request is a thing you do about a title, not about a person.
 */
export const UsersPane: React.FC<{ initialSection?: string }> = ({
  initialSection,
}) => {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>(
    sectionFromParam(initialSection),
  );

  return (
    <SettingsPane title={t("home.settings.nav.users")} scope='server'>
      <View testID='settings-users-tabs' style={{ marginBottom: space["4"] }}>
        <TabsBar
          segments={[
            { key: "people", label: t("home.settings.users.tab_people") },
            { key: "policy", label: t("home.settings.users.tab_policy") },
          ]}
          value={section}
          onChange={(v) => setSection(v as Section)}
        />
      </View>

      {section === "people" ? (
        <FocusTarget id={["accounts", "invitations", "library-access"]}>
          <UsersScreen />
        </FocusTarget>
      ) : (
        <FocusTarget id={["request-quota", "trusted-requesters"]}>
          <RequestPolicySection />
        </FocusTarget>
      )}
    </SettingsPane>
  );
};
