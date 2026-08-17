export interface TrayProxyLive { port: number }

export interface TrayProxyServiceState {
  installed: boolean;
  startable: boolean;
  summary: string;
}

export interface TrayProxyStartIo {
  findLive: () => Promise<TrayProxyLive | null>;
  diagnoseService: () => TrayProxyServiceState;
  startService: () => void | boolean | Promise<void | boolean>;
  /** Direct launches return their PID so readiness cannot adopt a racing proxy. */
  startDirect: () => void | number | Promise<void | number>;
  waitForProxy: (expectedPid?: number) => Promise<TrayProxyLive | null>;
  info: (message: string) => void;
  error: (message: string) => void;
}

/** Side-effect coordinator for the tray's fixed proxy-start action. */
export async function runTrayProxyStart(io: TrayProxyStartIo): Promise<boolean> {
  const live = await io.findLive();
  if (live) {
    io.info(`Proxy already running on port ${live.port}.`);
    return true;
  }

  const service = io.diagnoseService();
  if (service.installed && !service.startable) {
    io.error(`Cannot start from the tray because the installed service is not viable: ${service.summary}`);
    io.error("Repair or remove the service before starting a direct proxy.");
    return false;
  }

  let expectedPid: number | undefined;
  if (service.startable) {
    if (await io.startService() === false) {
      io.error("The service manager ran, but the proxy did not become healthy.");
      return false;
    }
  }
  else {
    const startedPid = await io.startDirect();
    if (typeof startedPid === "number" && Number.isSafeInteger(startedPid) && startedPid > 0) {
      expectedPid = startedPid;
    }
  }

  const started = await io.waitForProxy(expectedPid);
  if (!started) {
    io.error("Proxy did not become healthy after the tray start action.");
    return false;
  }
  io.info(`Proxy running on port ${started.port}.`);
  return true;
}

export async function runTrayProxyRestart(io: {
  stop: () => boolean | Promise<boolean>;
  start: () => boolean | Promise<boolean>;
}): Promise<boolean> {
  if (!await io.stop()) return false;
  return io.start();
}
