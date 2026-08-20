export declare const REAL_BUN_MIN_BYTES: number;

export declare function isRealBunBinary(
  path: string,
  stat?: (path: string) => { isFile: () => boolean; size: number },
): boolean;
