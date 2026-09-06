/**
 * The section switcher the StingStream screens already use, now drawn by the
 * shared `Tabs` primitive.
 *
 * M2 gave these screens a pill row of their own because there was nothing to
 * reuse; v0.2.0's `components/common/Tabs.tsx` is that row plus the underline
 * layout a desktop browser needs, so this file is the old names pointing at it.
 * Nothing that imports `SegmentedControl` or `SegmentedControlBar` has to
 * change; new code should import `Tabs` directly.
 */
export {
  type Segment,
  Tabs as SegmentedControl,
  TabsBar as SegmentedControlBar,
} from "@/components/common/Tabs";
