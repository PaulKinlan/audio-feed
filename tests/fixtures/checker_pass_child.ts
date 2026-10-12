/**
 * Child fixture for tests/proof_helper_test.ts.
 * Executes all-passing checks directly and through runProof().
 * Must exit zero.
 */
import { createChecker, runProof } from "../../scripts/proof-helper.ts";

const checker = createChecker();
checker.check("passing check direct", true, "detail ok");
checker.finish();

await runProof("child-pass-proof", (c) => {
  c.check("passing check in proof", true);
});
