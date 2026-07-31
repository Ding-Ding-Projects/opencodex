export interface TrustedPathDeps {
  cwd?: string;
  exists?: (path: string) => boolean;
}

export declare function resolveOnTrustedPath(
  command: string,
  env?: Record<string, string | undefined>,
  deps?: TrustedPathDeps,
): string | null;
