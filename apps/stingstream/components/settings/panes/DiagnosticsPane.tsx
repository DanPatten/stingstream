import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { TabsBar } from "@/components/common/Tabs";
import { LogsSection } from "@/components/stingstream/admin/LogsSection";
import { NodeStatusScreen } from "@/components/stingstream/node/NodeStatusScreen";
import { space } from "@/constants/theme";
import { FocusTarget } from "../FocusTarget";
import { SettingsPane } from "./SettingsPane";

type Section = "status" | "logs";

const SECTIONS: Section[] = ["status", "logs"];

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
  SECTIONS.find((s) => s === value) ?? "status";

/**
 * What the server is doing, and what it wrote down.
 *
 * Two pages before this — *Server status* and the server log viewer buried as
 * the third tab of *Libraries & transcoding* — and nobody opens one without
 * wanting the other: the status page says a child is unhealthy and the log says
 * why.
 *
 * The app's own log is deliberately **not** here. That one is what this copy of
 * the app recorded on this device, every account has it, and it is under About.
 */
export const DiagnosticsPane: React.FC<{ initialSection?: string }> = ({
  initialSection,
}) => {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>(
    sectionFromParam(initialSection),
  );

  return (
    <SettingsPane title={t("home.settings.nav.diagnostics")}>
      <View
        testID='settings-diagnostics-tabs'
        style={{ marginBottom: space["4"] }}
      >
        <TabsBar
          segments={[
            {
              key: "status",
              label: t("home.settings.diagnostics.tab_status"),
            },
            { key: "logs", label: t("home.settings.diagnostics.tab_logs") },
          ]}
          value={section}
          onChange={(v) => setSection(v as Section)}
        />
      </View>

      {section === "status" ? (
        <FocusTarget id='server-status'>
          <NodeStatusScreen />
        </FocusTarget>
      ) : (
        <FocusTarget id='server-logs'>
          <LogsSection />
        </FocusTarget>
      )}
    </SettingsPane>
  );
};
