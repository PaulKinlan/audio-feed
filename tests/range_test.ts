/**
 * Range parsing and resolution — the pure functions behind seekable playback.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { parseRangeHeader, RangeNotSatisfiableError, resolveRange } from "../src/storage/mod.ts";
import { parseContentRange } from "../src/storage/s3.ts";

Deno.test("parseRangeHeader: closed range", () => {
  assertEquals(parseRangeHeader("bytes=0-499"), { start: 0, end: 499 });
});

Deno.test("parseRangeHeader: open-ended range", () => {
  assertEquals(parseRangeHeader("bytes=500-"), { start: 500 });
});

Deno.test("parseRangeHeader: suffix range encodes as a negative start", () => {
  assertEquals(parseRangeHeader("bytes=-500"), { start: -500 });
});

Deno.test("parseRangeHeader: absent header", () => {
  assertEquals(parseRangeHeader(null), undefined);
});

Deno.test("parseRangeHeader: rejects unsupported and malformed forms", () => {
  // Multi-range is legal HTTP but unsupported here; it must degrade to a full
  // response rather than being silently misparsed as a single range.
  assertEquals(parseRangeHeader("bytes=0-99,200-299"), undefined);
  assertEquals(parseRangeHeader("items=0-99"), undefined);
  assertEquals(parseRangeHeader("bytes=-"), undefined);
  assertEquals(parseRangeHeader("garbage"), undefined);
});

Deno.test("resolveRange: no range means the whole object", () => {
  assertEquals(resolveRange(undefined, 100), null);
});

Deno.test("resolveRange: clamps the end to the object size", () => {
  assertEquals(resolveRange({ start: 0, end: 999 }, 100), { start: 0, end: 99, total: 100 });
});

Deno.test("resolveRange: resolves a suffix against the size", () => {
  assertEquals(resolveRange({ start: -30 }, 100), { start: 70, end: 99, total: 100 });
});

Deno.test("resolveRange: a suffix longer than the object returns the whole object", () => {
  assertEquals(resolveRange({ start: -500 }, 100), { start: 0, end: 99, total: 100 });
});

Deno.test("resolveRange: rejects a start at or past the end", () => {
  assertThrows(() => resolveRange({ start: 100 }, 100), RangeNotSatisfiableError);
  assertThrows(() => resolveRange({ start: 101 }, 100), RangeNotSatisfiableError);
});

Deno.test("resolveRange: rejects an inverted range", () => {
  assertThrows(() => resolveRange({ start: 50, end: 10 }, 100), RangeNotSatisfiableError);
});

Deno.test("resolveRange: any range over a zero-length object is unsatisfiable", () => {
  assertThrows(() => resolveRange({ start: 0 }, 0), RangeNotSatisfiableError);
});

Deno.test("parseContentRange: reads S3 responses", () => {
  assertEquals(parseContentRange("bytes 100-199/1000"), { start: 100, end: 199, total: 1000 });
});

Deno.test("parseContentRange: tolerates an unknown total", () => {
  assertEquals(parseContentRange("bytes 0-99/*"), { start: 0, end: 99, total: 100 });
});

Deno.test("parseContentRange: rejects junk", () => {
  assertEquals(parseContentRange("bytes nonsense"), null);
});
