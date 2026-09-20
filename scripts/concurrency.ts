/**
 * Bounded-concurrency async map.
 *
 * Shared by `count-lines.ts` and `line-attribution.ts`, each of which fans out one independent
 * git child process per tracked file (`git show`, and `cat-file`/`git blame`). Both used to run
 * those one file at a time in a plain loop, which serializes thousands of process launches behind
 * each other even though the files are completely independent of one another and the underlying
 * git calls can overlap freely.
 *
 * This lives in its own file, rather than inside either caller, so both can import the exact same
 * helper without one importing the other and creating an import cycle: `line-attribution.ts`
 * already imports `countLines` from `count-lines.ts`, so `count-lines.ts` cannot also statically
 * import from `line-attribution.ts`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error(`concurrency must be a positive safe integer; received ${String(concurrency)}`);
  }
  const results = new Array<R>(items.length);
  let next = 0;
  async function run(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}
