import { expect, test } from "bun:test";
import {
  isTerminalUpdateJobStatus,
  pollUpdateJob,
  shouldPollUpdateJob,
  updateJobNotificationBody,
} from "../src/pages/use-dashboard-data";
import type { UpdateJob } from "../src/pages/dashboard-shared";

const runningNoRestartJob: UpdateJob = {
  id: "job-no-restart",
  status: "running",
  currentVersion: "0.0.1",
  latestVersion: "0.0.2",
  channel: "latest",
  installer: "npm",
  restart: false,
  command: "ocx update",
  log: [],
};

test("no-restart update jobs are polled from running through terminal status", async () => {
  const originalFetch = globalThis.fetch;
  const responses: UpdateJob[] = [
    { ...runningNoRestartJob },
    { ...runningNoRestartJob, status: "succeeded", restarted: false },
  ];
  const requests: string[] = [];
  globalThis.fetch = (async input => {
    requests.push(String(input));
    return Response.json({ job: responses.shift() });
  }) as typeof fetch;

  try {
    const first = await pollUpdateJob("http://proxy.test", runningNoRestartJob, new AbortController().signal);
    expect(first.job?.status).toBe("running");
    expect(isTerminalUpdateJobStatus(first.job?.status)).toBe(false);
    expect(shouldPollUpdateJob(first.job ?? null)).toBe(true);

    const second = await pollUpdateJob("http://proxy.test", first.job!, new AbortController().signal);
    expect(second.job?.status).toBe("succeeded");
    expect(isTerminalUpdateJobStatus(second.job?.status)).toBe(true);
    expect(shouldPollUpdateJob(second.job ?? null)).toBe(false);
    expect(requests).toEqual([
      "http://proxy.test/api/update/status?jobId=job-no-restart",
      "http://proxy.test/api/update/status?jobId=job-no-restart",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a no-restart terminal success tells the user to restart manually", () => {
  const body = updateJobNotificationBody(
    { ...runningNoRestartJob, status: "succeeded", restarted: false },
    key => key,
  );
  expect(body).toContain("dash.updateManualRestart");
});

test("cancelled update jobs are terminal and do not keep polling", () => {
  expect(isTerminalUpdateJobStatus("cancelled")).toBe(true);
  expect(shouldPollUpdateJob({ ...runningNoRestartJob, status: "cancelled" })).toBe(false);
});
