/**
 * Gate actions that start host processes or mutate installed software.
 *
 * Management authentication protects configuration, but an administrator may
 * intentionally use the dashboard over the LAN. That credential must not also
 * become remote process execution. These actions are therefore available only
 * when the live listener itself is known to be loopback-bound. Configuration is
 * not evidence: PUT /api/host can change it without moving the existing socket.
 */

import { isLoopbackHostname, jsonResponse } from "../auth-cors";
import { getServerListenHostname } from "../lifecycle";
import type { ManagementContext } from "./context";

export function requireLoopbackListener(
  ctx: Pick<ManagementContext, "req" | "config">,
  action: string,
): Response | null {
  const listening = getServerListenHostname();
  if (listening !== undefined && isLoopbackHostname(listening)) return null;
  return jsonResponse({
    error: `${action} is available only while the proxy is listening on 127.0.0.1.`,
    reason: "loopback-required",
  }, 403, ctx.req, ctx.config);
}
