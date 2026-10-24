import assert from "assert";

import { e2eFixturesEnabled } from "../src/e2e.js";

describe("browser-test fixtures", () => {
  it("are mounted only with E2E_FIXTURES=1, and never in production", () => {
    assert.strictEqual(e2eFixturesEnabled({}), false);
    assert.strictEqual(e2eFixturesEnabled({ E2E_FIXTURES: "true" }), false);
    assert.strictEqual(e2eFixturesEnabled({ E2E_FIXTURES: "1" }), true);
    assert.strictEqual(e2eFixturesEnabled({ E2E_FIXTURES: "1", NODE_ENV: "test" }), true);
    assert.strictEqual(e2eFixturesEnabled({ E2E_FIXTURES: "1", NODE_ENV: "production" }), false);
  });
});
