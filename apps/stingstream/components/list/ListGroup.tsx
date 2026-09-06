import React, {
  Children,
  cloneElement,
  isValidElement,
  type PropsWithChildren,
  type ReactElement,
} from "react";
import { StyleSheet, View, type ViewProps, type ViewStyle } from "react-native";
import { radius, tokens } from "@/constants/theme";
import { Text } from "../common/Text";

interface Props extends ViewProps {
  title?: string | null | undefined;
  description?: ReactElement;
}

/**
 * A card of rows: the settings idiom the whole app is built out of.
 *
 * bg1 on the page's bg0, one hairline between rows and none at the ends, so a
 * group reads as a single object rather than a stack of lines. The rules are
 * cloned onto the children rather than drawn by each row, which is what keeps
 * the last row's edge clean without every call site knowing its own index.
 */
export const ListGroup: React.FC<PropsWithChildren<Props>> = ({
  title,
  children,
  description,
  ...props
}) => {
  const childrenArray = Children.toArray(children);

  return (
    <View {...props}>
      {title ? (
        <Text
          variant='micro'
          weight='semibold'
          tone='tertiary'
          style={{
            marginLeft: 16,
            marginBottom: 6,
            textTransform: "uppercase",
            letterSpacing: 0.6,
          }}
        >
          {title}
        </Text>
      ) : null}
      <View
        style={{
          flexDirection: "column",
          borderRadius: radius.md,
          overflow: "hidden",
          backgroundColor: tokens.color.bg["1"],
        }}
      >
        {Children.map(childrenArray, (child, index) => {
          if (isValidElement<{ style?: ViewStyle }>(child)) {
            return cloneElement(child as any, {
              style: StyleSheet.compose(
                child.props.style,
                index < childrenArray.length - 1
                  ? styles.borderBottom
                  : undefined,
              ),
            });
          }
          return child;
        })}
      </View>
      {description && (
        <View style={{ paddingLeft: 16, marginTop: 6 }}>{description}</View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  borderBottom: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.color.border.subtle,
  },
});
