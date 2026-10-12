/**
 * Child fixture for tests/proof_helper_test.ts.
 * Records a failing check via createChecker() and returns without calling finish().
 * Under fail-fast semantics, check() throws CheckFailureError immediately and exits non-zero.
 */
import { createChecker } from "../../scripts/proof-helper.ts";

const checker = createChecker();
checker.check("failing check mutant", false, "should fail fast");
