// Reads a body stream up to a size limit, and stops reading as soon as it is over: request bodies,
// facilitator answers and upstream answers are all bounded.

/** The bytes, or undefined if there are more than `maxBytes`. */
export async function readBounded(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array | undefined> {
  const reader = body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
