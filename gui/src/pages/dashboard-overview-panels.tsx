import MemoryObservabilityCard from "../components/MemoryObservabilityCard";
import type { useDashboardData } from "./use-dashboard-data";
import {
  DashboardEffortCapPanel,
  DashboardInjectionPanel,
  DashboardMaintenancePanel,
  DashboardSidecarPanels,
} from "./dashboard-overview-sections";

type Dash = ReturnType<typeof useDashboardData>;

export function DashboardOverviewPanels(props: Dash) {
  // Maintenance closes the overview, as it does in the prototype: sync and
  // update act on everything configured above them, so they read as the last
  // step rather than an interruption in the middle of the settings stack.
  return (
    <>
      <DashboardEffortCapPanel apiBase={props.apiBase} d={props} />
      <DashboardInjectionPanel apiBase={props.apiBase} d={props} />
      <DashboardSidecarPanels d={props} />
      <MemoryObservabilityCard apiBase={props.apiBase} />
      <DashboardMaintenancePanel d={props} />
    </>
  );
}
