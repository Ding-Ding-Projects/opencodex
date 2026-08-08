export type GlobalMemoryAction = "status" | "install" | "uninstall";
export type GlobalMemoryTarget = "all" | "claude" | "codex" | "opencode";

export interface GlobalMemoryRequest {
  action: GlobalMemoryAction;
  repositoryPath?: string;
  targets?: GlobalMemoryTarget[];
  homeDirectory?: string;
  yes?: boolean;
  dryRun?: boolean;
}

export type GlobalMemoryItemState =
  | "current"
  | "missing"
  | "drift"
  | "conflict"
  | "retained"
  | "unknown";

export interface GlobalMemoryResult {
  action: GlobalMemoryAction;
  repositoryPath: string;
  origin: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  items: Array<{
    name: string;
    state: GlobalMemoryItemState;
    path?: string;
    reason?: string;
  }>;
}

export interface GlobalMemoryRepository {
  repositoryPath: string;
  origin: string;
  payloadPath: string;
  skillPath: string;
  synchronizerPath: string;
  platform: "win32" | "posix";
}

export interface ProjectProfile {
  slug: string;
  path: string;
}

export interface ProjectProfileList {
  schemaVersion: 1;
  repository: string;
  profiles: ProjectProfile[];
}

export interface ProjectProfileShow {
  schemaVersion: 1;
  repository: string;
  profile: ProjectProfile & { content: string };
}
