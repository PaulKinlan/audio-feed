/**
 * Tests for src/log.ts (audio-feed-8pjp).
 *
 * Verifies that Logger.failure:
 * 1. Screens thrown errors and reasons against client-chosen text and canaries using closed-set screens.
 * 2. Retains structured error identifiers (error.name from KNOWN_ERROR_NAMES) and recognized diagnostic prefixes.
 * 3. Preserves computability and distribution grouping: novel errors sharing the same structured name
 *    group together in context.errorName even when their free text is suppressed.
 */

import { assert, assertEquals } from "@std/assert";
import { createLogger, type LogSink } from "../src/log.ts";
import type { LogRecord } from "../src/storage/mod.ts";
import { SUPPRESSED_MESSAGE } from "../src/observability/error_screen.ts";

const CANARY = "qV7z52CapSECRETfd39Nd";

Deno.test("audio-feed-8pjp: Logger.failure screens thrown errors against canary leakage in message, reason, and stack", async () => {
  const records: LogRecord[] = [];
  const sink: LogSink = {
    appendLog: (rec) => {
      records.push(rec as LogRecord);
      return Promise.resolve(rec as LogRecord);
    },
  };
  const logger = createLogger({ sink, process: "worker" });

  // 1. Hostile canary error: canary in message, name, and stack
  const hostileErr = new Error(`provider said: ${CANARY}`);
  hostileErr.name = `CustomHostile_${CANARY}`;
  hostileErr.stack =
    `CustomHostile_${CANARY}: provider said: ${CANARY}\n  at /app/routes/${CANARY}.ts:42:10`;

  await logger.failure("synthesis.failure", hostileErr);

  assertEquals(records.length, 1);
  const rec1 = records[0]!;
  assertEquals(rec1.severity, "error");
  assertEquals(rec1.type, "synthesis.failure");
  assertEquals(rec1.message, SUPPRESSED_MESSAGE, "message must be conservatively suppressed");
  assertEquals(rec1.reason, SUPPRESSED_MESSAGE, "reason must be conservatively suppressed");
  assertEquals(rec1.context?.errorName, "Error", "hostile name must be screened to Error");
  assertEquals(
    rec1.stack,
    `Error: ${SUPPRESSED_MESSAGE}`,
    "stack must contain only screened header",
  );
  assert(!rec1.message.includes(CANARY), "canary must not reach message");
  assert(!String(rec1.reason).includes(CANARY), "canary must not reach reason");
  assert(!String(rec1.stack).includes(CANARY), "canary must not reach stack");

  // 2. Recognized codebase error: retains useful diagnostic prefix and strips tail
  const knownErr = new Error(
    "Synthesis segment cannot fit in byte budget: segment length 65536 exceeds limit",
  );
  knownErr.name = "GeminiTtsError";

  await logger.failure("synthesis.failure", knownErr);

  assertEquals(records.length, 2);
  const rec2 = records[1]!;
  assertEquals(rec2.message, "Synthesis segment cannot fit in byte budget");
  assertEquals(rec2.reason, "Synthesis segment cannot fit in byte budget");
  assertEquals(rec2.context?.errorName, "GeminiTtsError");
  assertEquals(rec2.stack, "GeminiTtsError: Synthesis segment cannot fit in byte budget");

  // 3. Caller-supplied reason with canary: fields.reason is also screened
  await logger.failure("synthesis.failure", new Error("harmless"), {
    reason: `custom reason with ${CANARY}`,
  });
  assertEquals(records.length, 3);
  const rec3 = records[2]!;
  assertEquals(rec3.reason, SUPPRESSED_MESSAGE);
  assert(!String(rec3.reason).includes(CANARY));
});

Deno.test("audio-feed-8pjp: novel errors with the same name group together under screening", async () => {
  const records: LogRecord[] = [];
  const sink: LogSink = {
    appendLog: (rec) => {
      records.push(rec as LogRecord);
      return Promise.resolve(rec as LogRecord);
    },
  };
  const logger = createLogger({ sink, process: "worker" });

  // Two distinct novel errors with the same class/name (TypeError) carrying different client payloads
  const typeErr1 = new TypeError(`unexpected null pointer in article ${CANARY}_A`);
  const typeErr2 = new TypeError(`cannot read property length of undefined in session ${CANARY}_B`);

  // Another distinct error class (RangeError)
  const rangeErr = new RangeError(`invalid allocation size in worker ${CANARY}_C`);

  // Hostile error with arbitrary custom name
  const hostileErr = new Error(`arbitrary failure ${CANARY}_D`);
  hostileErr.name = `AttackerClass_${CANARY}`;

  await logger.failure("synthesis.failure", typeErr1);
  await logger.failure("synthesis.failure", typeErr2);
  await logger.failure("synthesis.failure", rangeErr);
  await logger.failure("synthesis.failure", hostileErr);

  assertEquals(records.length, 4);

  // Group records by structured error identifier (context.errorName)
  const groupedByName = new Map<string, LogRecord[]>();
  for (const rec of records) {
    const errorName = String(rec.context?.errorName ?? "unknown");
    const group = groupedByName.get(errorName) ?? [];
    group.push(rec);
    groupedByName.set(errorName, group);
  }

  // Distribution verification:
  // 1. Both TypeErrors group together under 'TypeError' despite different novel messages
  const typeErrorGroup = groupedByName.get("TypeError");
  assert(typeErrorGroup !== undefined);
  assertEquals(typeErrorGroup.length, 2);
  assertEquals(typeErrorGroup[0]?.message, SUPPRESSED_MESSAGE);
  assertEquals(typeErrorGroup[1]?.message, SUPPRESSED_MESSAGE);

  // 2. RangeError forms its own distinct group
  const rangeErrorGroup = groupedByName.get("RangeError");
  assert(rangeErrorGroup !== undefined);
  assertEquals(rangeErrorGroup.length, 1);
  assertEquals(rangeErrorGroup[0]?.message, SUPPRESSED_MESSAGE);

  // 3. Hostile name falls back to 'Error' group
  const defaultErrorGroup = groupedByName.get("Error");
  assert(defaultErrorGroup !== undefined);
  assertEquals(defaultErrorGroup.length, 1);
  assertEquals(defaultErrorGroup[0]?.message, SUPPRESSED_MESSAGE);

  // 4. All canaries are completely absent across the entire distribution
  for (const rec of records) {
    assert(!rec.message.includes(CANARY));
    assert(!String(rec.reason).includes(CANARY));
    assert(!String(rec.stack).includes(CANARY));
  }
});
