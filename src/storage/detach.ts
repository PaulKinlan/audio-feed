/**
 * Best-effort detachment / release of the underlying ArrayBuffer for a Uint8Array.
 * Uses ArrayBuffer.prototype.transfer(0) when available, releasing V8 external memory.
 */
export function detachUint8Array(bytes?: Uint8Array | null): void {
  if (!bytes) return;
  try {
    const buf = bytes.buffer;
    if (
      buf instanceof ArrayBuffer &&
      !buf.detached &&
      bytes.byteOffset === 0 &&
      bytes.byteLength === buf.byteLength &&
      typeof (buf as { transfer?: (newByteLength?: number) => ArrayBuffer }).transfer === "function"
    ) {
      (buf as { transfer: (newByteLength?: number) => ArrayBuffer }).transfer(0);
    }
  } catch {
    // Ignore environments where transfer() is unsupported or fails
  }
}
