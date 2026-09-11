import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { TabsBar } from "@/components/common/Tabs";
import { RequestPolicySection } from "@/components/stingstream/requests/RequestPolicySection";
import { UsersScreen } from "@/components/stingstream/users/UsersScreen";
import { space } from "@/constants/theme";
import { useRequestsMode } from "@/lib/stingstream/requests";
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
export const sectionFromParam = (
  value: string | undefined,
  sections: readonly Section[] = SECTIONS,
): Section => sections.find((s) => s === value) ?? sections[0];

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
  // With no indexer configured anywhere in the group there is nothing to approve, so the policy
  // deciding who needs approving has nothing to govern either. The tab goes with it; the category
  // stays, because accounts, invitations and library access are still here.
  const manual = useRequestsMode() === "manual";
  const sections: readonly Section[] = manual
    ? (["people"] as const)
    : SECTIONS;
  const [section, setSection] = useState<Section>(
    sectionFromParam(initialSection),
  );

  return (
    <SettingsPane title={t("home.settings.nav.users")}>
      {sections.length > 1 ? (
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
      ) : null}

      {/*
        Falls back rather than trusting the state: a `?tab=policy` link saved while the group had an
        indexer still resolves here after the last one is removed, and the mode arrives a moment
        after the first paint. Deciding on the section alone would leave a blank pane under a tab
        bar that is no longer drawn.
      */}
      {section === "people" || manual ? (
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
