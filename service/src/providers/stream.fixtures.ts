/**
 * Test-only helpers for driving the SSE parsers without a live provider.
 * Not part of the runtime graph - excluded from coverage in `vitest.config.ts`.
 */

/** Build a byte stream from string chunks, preserving the chunk boundaries. */
export function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

export async function collect<T>(source: AsyncGenerator<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}
