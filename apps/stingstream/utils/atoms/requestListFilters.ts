import { atom } from "jotai";
import type {
  RequestListFilters,
  RequestListSection,
} from "@/components/stingstream/requests/requestListFilters";

/**
 * The last filters each request list was left with, while the app is open.
 *
 * The URL holds the filters of the section on screen, so a filtered view is linkable. This holds the
 * others, so leaving My requests filtered to Waiting for Approvals and coming back finds it still
 * filtered to Waiting. In memory only: a filter is part of an errand, and a fresh start should show
 * the whole list.
 */
export const requestListFiltersAtom = atom<
  Partial<Record<RequestListSection, RequestListFilters>>
>({});
