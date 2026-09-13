/**
 * Web build of `@expo/react-native-action-sheet`.
 *
 * The real package draws a drawer that slides up from the bottom of the window. That is the right
 * shape on a phone and the wrong one in a browser, where every other modal is a centred dialog. So
 * Metro resolves this file instead whenever `platform === "web"` (`webModuleStubs` in
 * `metro.config.js`): the same API, with each request handed to `lib/platform/actionSheetStore.ts`
 * and drawn as a `Dialog` by `components/common/ActionSheetDialog.tsx`, which the root layout
 * mounts beside the toaster.
 *
 * Native bundles never see this file, so a phone keeps its platform sheet.
 */

import type {
  ActionSheetOptions,
  ActionSheetProps,
  ActionSheetProviderRef,
} from "@expo/react-native-action-sheet";
import {
  type ComponentType,
  forwardRef,
  type ReactNode,
  useImperativeHandle,
} from "react";
import { actionSheetStore } from "@/lib/platform/actionSheetStore";

export type {
  ActionSheetIOSOptions,
  ActionSheetOptions,
  ActionSheetProps,
  ActionSheetProviderRef,
} from "@expo/react-native-action-sheet";

const context: ActionSheetProps = {
  showActionSheetWithOptions: (options: ActionSheetOptions, callback) =>
    actionSheetStore.show(options, callback),
};

/** Nothing to provide: the request goes to a module store, and the dialog lives at the root. */
export const ActionSheetProvider = forwardRef<
  ActionSheetProviderRef,
  { children?: ReactNode; useNativeDriver?: boolean }
>(({ children }, ref) => {
  useImperativeHandle(ref, () => ({ ...context, getContext: () => context }));
  return <>{children}</>;
});
ActionSheetProvider.displayName = "ActionSheetProvider";

export const useActionSheet = (): ActionSheetProps => context;

export function connectActionSheet<P>(
  Component: ComponentType<P & ActionSheetProps>,
): ComponentType<P> {
  const Connected = (props: P) => <Component {...props} {...context} />;
  Connected.displayName = `connectActionSheet(${Component.displayName ?? Component.name ?? "Component"})`;
  return Connected;
}
