/**
 * What a request record names instead of a path (audio-feed-wzv9, audio-feed-pwu4).
 *
 * WHY THE PATH IS NEVER RECORDED. An observability store must not hold user-controlled strings, and
 * a request path is the one place this app carries capabilities with no field name attached:
 * `/listen/<feedToken>`, `/audio/<key>`, `/feed/<token>/master.xml`. Two attempts at sanitising the
 * path leaked. The first matched known shapes and copied the tail of a matched `/feed/<token>/...`
 * through. The second was fail-closed but still lost: an uppercase prefix dodged the prefix rule and
 * a SHORT lower-case token then looked exactly like a route word. Every version of "decide whether
 * this segment is a secret" is a policy for the shapes someone thought of, and the shape that
 * arrives is chosen by the attacker.
 *
 * So the recorded value is a CONSTANT: the pattern the router matched, taken from the route table,
 * or this marker when nothing matched. A leak is then impossible by construction rather than
 * improbable by heuristic, and an operator still learns which route was attempted.
 */

/** Recorded for a request that matched no route. A constant, like every other recorded route. */
export const UNMATCHED_ROUTE = "<unmatched>";
