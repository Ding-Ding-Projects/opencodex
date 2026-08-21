import { useSyncExternalStore } from "react";
import { isSchoolModeActive, subscribeSchoolMode } from "./school-mode";

export function useSchoolModeActive(): boolean {
  return useSyncExternalStore(subscribeSchoolMode, isSchoolModeActive, () => false);
}
