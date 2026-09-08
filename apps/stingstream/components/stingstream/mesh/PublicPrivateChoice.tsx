import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Icon } from "@/components/common/Icon";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { space } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";

/**
 * How people connect to a group: through a server, or not.
 *
 * This replaced a screen that asked you to pick "Default" or "My own server", explained iroh's
 * relays, n0 DNS and the BitTorrent DHT in a paragraph, and then offered a third row about hosting
 * your own — for a decision with exactly two outcomes. Dan's verdict was that it was "confusing as
 * fuck", and the diagnosis is that it was written from the mesh outwards rather than from the
 * question a person is actually answering.
 *
 * The question is whether two homes can reach each other **at all**. Public puts a server in the
 * middle that introduces members and passes the connection along when a direct one is impossible —
 * carrier-grade NAT, blocked UDP, a strict firewall. Private is direct, over public internet
 * infrastructure only, and on some networks it will not connect.
 *
 * What neither line says, deliberately: that Public lets someone join while your server is off. It
 * is true of the join handshake alone, and worthless on its own — nobody can watch anything until
 * the server is back — so offering it as the reason to pick Public reads as a promise the product
 * does not keep. Dan caught exactly that in the first draft of this copy.
 *
 * **Which** server Public uses is not asked here. It lives on the Sharing server settings page,
 * because it is a property of this node rather than of the group being created, and because a
 * choice between two things should not come with a text field attached to one of them.
 */

export type GroupVisibility = "public" | "private";

export function PublicPrivateChoice({
  value,
  onChange,
  /** False when no sharing server is configured, which makes Public impossible rather than unwise. */
  publicAvailable,
  disabled,
}: {
  value: GroupVisibility;
  onChange: (next: GroupVisibility) => void;
  publicAvailable: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <ListGroup title={t("sharing.connect_label")}>
      <ListItem
        testID='sharing-visibility-public'
        title={t("sharing.public_title")}
        subtitle={
          publicAvailable
            ? t("sharing.public_body")
            : t("sharing.public_needs_server")
        }
        disabled={disabled || !publicAvailable}
        onPress={
          disabled || !publicAvailable ? undefined : () => onChange("public")
        }
        iconAfter={<Selected on={value === "public"} />}
      />
      <ListItem
        testID='sharing-visibility-private'
        title={t("sharing.private_title")}
        subtitle={t("sharing.private_body")}
        disabled={disabled}
        onPress={disabled ? undefined : () => onChange("private")}
        iconAfter={<Selected on={value === "private"} />}
      />
    </ListGroup>
  );
}

/**
 * The radio itself.
 *
 * The picker this replaced drew its own with the characters `●` and `○`, which sit on the text
 * baseline and take the font's metrics rather than the row's, so they lined up with nothing beside
 * them. These come from the icon registry like every other control.
 */
const Selected = ({ on }: { on: boolean }) => {
  const { accent } = useTheme();
  return (
    <View style={{ marginLeft: space[2] }}>
      <Icon
        name={on ? "radioOn" : "radioOff"}
        size={22}
        color={on ? accent[400] : undefined}
        tone={on ? undefined : "tertiary"}
      />
    </View>
  );
};

/**
 * A group is Public exactly when it carries a coordinator.
 *
 * One function so the create screen, the group screen and any test agree on it. There is no third
 * state and no flag: the coordinator's presence *is* the visibility, which is what keeps a group
 * read back from the node from disagreeing with the radio that made it.
 */
export const visibilityOf = (
  coordinator: string | null | undefined,
): GroupVisibility => (coordinator?.trim() ? "public" : "private");

/** The `coordinator` to send when creating or changing a group. */
export const coordinatorFor = (
  visibility: GroupVisibility,
  sharingServer: string | null,
): string | null => (visibility === "public" ? sharingServer : null);
