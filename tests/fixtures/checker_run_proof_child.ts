/**
 * Child fixture for tests/proof_helper_test.ts.
 * Uses runProof() to defer failures, runs a failing check, and returns without calling finish().
 * runProof() must invoke finish() in finally, exit non-zero, and print the failure to stderr.
 */
import { runProof } from "../../scripts/proof-helper.ts";

await runProof("child-deferred-proof", (checker) => {
  checker.check("failing check alpha", false, "reason A");
});
