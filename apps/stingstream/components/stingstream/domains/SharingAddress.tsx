import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Input } from "@/components/common/Input";
import { Text } from "@/components/common/Text";
import {
  type SharingAddressValue,
  sharingAddress,
  sharingAddressProblem,
} from "@/utils/mesh/sharingAddress";

// The rules live in `utils/mesh/sharingAddress.ts`, outside React, where `bun:test` can reach
// them — a field that says one thing while the node stores another is the failure this rework
// exists to remove, and no screenshot catches it. Re-exported so nothing importing this component
// has to know where they moved.
export {
  type SharingAddressValue,
  sharingAddress,
  sharingAddressProblem,
  sharingAddressReady,
  sharingAddressUrl,
} from "@/utils/mesh/sharingAddress";

/**
 * The address somebody has pointed at this server.
 *
 * It used to probe what it was typing at, so it could tell a *sharing server* from your own. There
 * is only one kind of address now, and the probe was never right for it: an admin editing their
 * home domain from mobile data cannot resolve it from where they are standing, so the field marked
 * a perfectly good value wrong and disabled Save. What is checked here is the shape, at the
 * keyboard; the node checks the rest when it stores it.
 */
export function SharingAddress({
  value,
  onChange,
  disabled,
  placeholder,
  blankHint,
  stored,
  testID,
}: {
  value: SharingAddressValue;
  onChange: (next: SharingAddressValue) => void;
  disabled?: boolean;
  placeholder: string;
  /**
   * What an empty field means, when that is worth a line.
   *
   * Optional since the Domains page: the status above the field already says which address is in
   * use and what it costs, so a second sentence saying the same thing under the box was two
   * explanations of one fact.
   */
  blankHint?: string;
  /** What the node already has, so an untouched value is left alone rather than re-judged. */
  stored?: string | null;
  testID?: string;
}) {
  const { t } = useTranslation();
  const input = value.input;
  const isStored = input.trim() === (stored ?? "").trim();

  const setInput = useCallback(
    (next: string) => onChange(sharingAddress(next)),
    [onChange],
  );

  // An untouched value is never marked wrong: it came from the node, so it is not a typo, and the
  // node's rules are the ones that matter for it.
  const problem = isStored ? null : sharingAddressProblem(value);

  return (
    <View>
      <Input
        placeholder={placeholder}
        autoCapitalize='none'
        autoCorrect={false}
        keyboardType='url'
        editable={!disabled}
        value={input}
        onChangeText={setInput}
        testID={testID}
      />
      <Text
        variant='caption'
        tone={problem ? "danger" : "tertiary"}
        style={{ marginTop: 6 }}
      >
        {problem
          ? t(`sharing.address_problem_${problem.replace(/-/g, "_")}`)
          : input.trim()
            ? t("sharing.address_ok")
            : blankHint}
      </Text>
    </View>
  );
}
