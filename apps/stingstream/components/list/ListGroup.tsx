import React, {
  Children,
  cloneElement,
  isValidElement,
  type PropsWithChildren,
  type ReactElement,
} from "react";
import { StyleSheet, View, type ViewProps, type ViewStyle } from "react-native";
import { radius } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
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
  const { color } = useTheme();
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
          backgroundColor: color.bg["1"],
        }}
      >
        {/*
          The divider is built here rather than in a module-scope
          `StyleSheet.create`, which would bake one theme's border color into
          the bundle.
        */}
        {Children.map(childrenArray, (child, index) => {
          if (isValidElement<{ style?: ViewStyle }>(child)) {
            return cloneElement(child as any, {
              style: StyleSheet.compose(
                child.props.style,
                index < childrenArray.length - 1
                  ? {
                      borderBottomWidth: StyleSheet.hairlineWidth,
                      borderBottomColor: color.border.subtle,
                    }
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
