/**
 * Node/Vitest-native drop-in implementation of `@std/assert` built on `node:assert/strict`.
 */

import nodeAssert from "node:assert/strict";

export class AssertionError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "AssertionError";
  }
}

export function fail(msg?: string): never {
  throw new AssertionError(msg ?? "Failed assertion.");
}

export function assert(expr: unknown, msg = ""): asserts expr {
  if (!expr) {
    throw new AssertionError(msg || "Expected truthy value.");
  }
}

export function assertFalse(expr: unknown, msg = ""): asserts expr is false | 0 | "" | null | undefined {
  if (expr) {
    throw new AssertionError(msg || `Expected falsy value, got ${String(expr)}`);
  }
}

export function assertExists<T>(actual: T, msg?: string): asserts actual is NonNullable<T> {
  if (actual === undefined || actual === null) {
    throw new AssertionError(msg ?? `Expected actual "${String(actual)}" to not be null or undefined.`);
  }
}

export function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  try {
    nodeAssert.deepStrictEqual(actual, expected);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new AssertionError(
      msg ? `Values are not equal: ${msg}\n${detail}` : `Values are not equal.\n${detail}`,
    );
  }
}

export function assertNotEquals<T>(actual: T, expected: T, msg?: string): void {
  nodeAssert.notDeepStrictEqual(actual, expected, msg);
}

export function assertStrictEquals<T>(actual: unknown, expected: T, msg?: string): asserts actual is T {
  nodeAssert.strictEqual(actual, expected, msg);
}

export function assertNotStrictEquals<T>(actual: T, expected: T, msg?: string): void {
  nodeAssert.notStrictEqual(actual, expected, msg);
}

export function assertStringIncludes(actual: string, expected: string, msg?: string): void {
  if (typeof actual !== "string" || !actual.includes(expected)) {
    throw new AssertionError(
      msg ?? `Expected actual string to include ${JSON.stringify(expected)}, got ${JSON.stringify(actual.slice(0, 500))}`,
    );
  }
}

export function assertMatch(actual: string, expected: RegExp, msg?: string): void {
  if (!expected.test(actual)) {
    throw new AssertionError(
      msg ?? `Expected ${JSON.stringify(actual.slice(0, 500))} to match ${String(expected)}`,
    );
  }
}

export function assertNotMatch(actual: string, expected: RegExp, msg?: string): void {
  if (expected.test(actual)) {
    throw new AssertionError(
      msg ?? `Expected ${JSON.stringify(actual.slice(0, 500))} NOT to match ${String(expected)}`,
    );
  }
}

export function assertGreater<T>(actual: T, expected: T, msg?: string): void {
  if (!(actual > expected)) {
    throw new AssertionError(msg ?? `Expected ${String(actual)} > ${String(expected)}`);
  }
}

export function assertGreaterOrEqual<T>(actual: T, expected: T, msg?: string): void {
  if (!(actual >= expected)) {
    throw new AssertionError(msg ?? `Expected ${String(actual)} >= ${String(expected)}`);
  }
}

export function assertLess<T>(actual: T, expected: T, msg?: string): void {
  if (!(actual < expected)) {
    throw new AssertionError(msg ?? `Expected ${String(actual)} < ${String(expected)}`);
  }
}

export function assertLessOrEqual<T>(actual: T, expected: T, msg?: string): void {
  if (!(actual <= expected)) {
    throw new AssertionError(msg ?? `Expected ${String(actual)} <= ${String(expected)}`);
  }
}

export function assertArrayIncludes<T>(
  actual: readonly T[],
  expected: readonly T[],
  msg?: string,
): void {
  for (const item of expected) {
    const found = actual.some((a) => {
      try {
        nodeAssert.deepStrictEqual(a, item);
        return true;
      } catch {
        return false;
      }
    });
    if (!found) {
      throw new AssertionError(
        msg ?? `Expected array to include ${JSON.stringify(item)}`,
      );
    }
  }
}

export function assertObjectMatch(
  actual: Record<PropertyKey, unknown>,
  expected: Record<PropertyKey, unknown>,
  msg?: string,
): void {
  for (const [k, v] of Object.entries(expected)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      assert(actual[k] && typeof actual[k] === "object", msg ?? `Missing object property "${k}"`);
      assertObjectMatch(
        actual[k] as Record<PropertyKey, unknown>,
        v as Record<PropertyKey, unknown>,
        msg,
      );
    } else {
      nodeAssert.deepStrictEqual(actual[k], v, msg ?? `Property "${k}" mismatch`);
    }
  }
}

export function assertAlmostEquals(
  actual: number,
  expected: number,
  tolerance = 1e-7,
  msg?: string,
): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new AssertionError(
      msg ?? `Expected ${actual} to be within ${tolerance} of ${expected}`,
    );
  }
}

type ErrorConstructor<E extends Error = Error> = new (...args: never[]) => E;

function checkError<E extends Error>(
  err: unknown,
  ErrorClass?: ErrorConstructor<E>,
  msgIncludes?: string,
  msg?: string,
): E {
  if (ErrorClass && !(err instanceof ErrorClass)) {
    throw new AssertionError(
      msg ?? `Expected error to be instance of ${ErrorClass.name}, got ${String(err)}`,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  if (msgIncludes && !message.includes(msgIncludes)) {
    throw new AssertionError(
      msg ?? `Expected error message "${message}" to include "${msgIncludes}"`,
    );
  }
  return err as E;
}

export function assertThrows<E extends Error = Error>(
  fn: () => unknown,
  ErrorClassOrMsg?: ErrorConstructor<E> | string,
  msgIncludes?: string,
  msg?: string,
): E {
  let threw = false;
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    threw = true;
    caught = err;
  }
  if (!threw) {
    throw new AssertionError(
      typeof ErrorClassOrMsg === "string" ? ErrorClassOrMsg : (msg ?? "Expected function to throw."),
    );
  }
  if (typeof ErrorClassOrMsg === "string") {
    return caught as E;
  }
  return checkError<E>(caught, ErrorClassOrMsg, msgIncludes, msg);
}

export async function assertRejects<E extends Error = Error>(
  fn: () => PromiseLike<unknown>,
  ErrorClassOrMsg?: ErrorConstructor<E> | string,
  msgIncludes?: string,
  msg?: string,
): Promise<E> {
  let threw = false;
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    threw = true;
    caught = err;
  }
  if (!threw) {
    throw new AssertionError(
      typeof ErrorClassOrMsg === "string" ? ErrorClassOrMsg : (msg ?? "Expected function to reject."),
    );
  }
  if (typeof ErrorClassOrMsg === "string") {
    return caught as E;
  }
  return checkError<E>(caught, ErrorClassOrMsg, msgIncludes, msg);
}

export function assertInstanceOf<T extends abstract new (...args: never[]) => unknown>(
  actual: unknown,
  expectedType: T,
  msg?: string,
): asserts actual is InstanceType<T> {
  if (!(actual instanceof expectedType)) {
    throw new AssertionError(
      msg ?? `Expected value to be instance of ${expectedType.name}, got ${String(actual)}`,
    );
  }
}
