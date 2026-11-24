/**
 * Executa uma lista de tarefas assíncronas com limite máximo de concorrência,
 * preservando a ordem original dos resultados.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runnerCount = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: runnerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex++;
        if (currentIndex >= items.length) {
          return;
        }
        results[currentIndex] = await worker(items[currentIndex] as T, currentIndex);
      }
    })
  );

  return results;
}
