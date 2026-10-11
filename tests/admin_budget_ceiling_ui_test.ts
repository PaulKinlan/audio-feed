/**
 * audio-feed-umac — the console must not tell an operator that "blank" means unlimited.
 *
 * THE BUG (a review note on audio-feed-khk3, filed as this bead by audio-feed-rev-khk3b)
 * khk3 gave a subscriber with no budget of their own a real ceiling — the deployment default,
 * `DEFAULT_DAILY_EPISODE_BUDGET`. Three places still described that state as unlimited: the
 * subscriber form's hint ("Blank for unlimited"), its placeholder ("Unlimited"), and the manage
 * panel's row for a subscriber whose budget is unset. So a form that grants a hard 50/day said it
 * granted no limit. That is the same failure khk3 itself was about — a surface making a false claim
 * about the limit it exists to show — only one layer up, and an operator acts on it.
 *
 * WHAT THESE TESTS PIN
 * 1. The rendered form names the configured default, and no longer says "unlimited" anywhere near
 *    the budget field.
 * 2. The number is the page's payload, not text baked into the markup: rendering with 7 must show 7.
 *    A literal in the template is how this went stale in the first place.
 * 3. A default of 0 is explained rather than printed as a bare zero, because "default of 0" reads
 *    like a bug to the person who set it deliberately.
 * 4. The console's client shows the effective ceiling per subscriber through the real shipped
 *    module — "Default (7 episodes/day)" for one without a budget of their own, their own number
 *    otherwise — and says how many subscribers are running on the default.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderAdminPage } from "../src/routes/admin.ts";
import { DEFAULT_DAILY_EPISODE_BUDGET } from "../src/config.ts";
import { runAdminScript } from "./admin_script.ts";
import type { StubElement } from "./admin_script.ts";

/**
 * The harness's stub DOM keeps `textContent` as a plain property, so a container's own text is
 * empty and its children's is the content. Reading both is the whole rendered text.
 */
function textOf(el: StubElement): string {
  return [el.textContent, ...el.descendants().map((child) => child.textContent)].join(" ");
}

const page = (defaultDailyEpisodeBudget?: number) =>
  renderAdminPage({
    nonce: "test-nonce",
    publicBaseUrl: "https://audio.example.com",
    adminConfigured: true,
    ...(defaultDailyEpisodeBudget === undefined ? {} : { defaultDailyEpisodeBudget }),
  });

/** The budget field's own markup, so a match elsewhere on the page cannot satisfy an assertion. */
function budgetField(html: string): string {
  const start = html.indexOf('for="newDailyBudget"');
  assert(start > 0, "the subscriber form must still have a daily budget field");
  return html.slice(start, start + 700);
}

Deno.test("the subscriber form states the ceiling blank means, and claims no other (audio-feed-umac)", () => {
  const html = page(7);
  const field = budgetField(html);

  assertStringIncludes(field, "deployment default of 7");
  assertStringIncludes(field, 'placeholder="Default (7)"');
  assertEquals(
    /unlimited/i.test(field),
    false,
    'the field must not say "unlimited" for a state that is capped — that was audio-feed-umac',
  );
});

Deno.test("the ceiling in the form comes from the page's data, not from a literal (audio-feed-umac)", () => {
  // 50 is the shipped constant; rendering 7 must print 7, or the text is decoration that will go
  // stale the next time the default is tuned.
  assertStringIncludes(budgetField(page(7)), "default of 7");
  assertStringIncludes(budgetField(page()), `default of ${DEFAULT_DAILY_EPISODE_BUDGET}`);

  const island = /<script\b[^>]*id="admin-data"[^>]*>([\s\S]*?)<\/script>/.exec(page(7));
  assert(island, "the page must still carry the #admin-data island");
  assertEquals(
    JSON.parse(island![1]!).defaultDailyEpisodeBudget,
    7,
    "the console's client reads the ceiling from the island",
  );
});

Deno.test("a default of zero is explained, not just printed (audio-feed-umac)", () => {
  const field = budgetField(page(0));
  assertStringIncludes(field, "deployment default of 0");
  assertStringIncludes(
    field,
    "nothing is synthesised until a budget is set",
    "0 is legal and means nobody synthesises: printing a bare zero reads like a bug",
  );
});

// -- the console's own client, driven through the shipped module ------------

const SUBSCRIBERS = [
  { id: "u-1", email: "on-default@example.com", displayName: "Default", status: "approved" },
  {
    id: "u-2",
    email: "configured@example.com",
    displayName: "Configured",
    status: "approved",
    dailyEpisodeBudget: 3,
  },
];

async function consoleOn(defaultDailyEpisodeBudget: number) {
  const harness = await runAdminScript({
    defaultDailyEpisodeBudget,
    storedToken: "admin-secret",
    respond: (method, path) => {
      if (method === "GET" && path === "/api/admin/users") return { users: SUBSCRIBERS };
      if (method === "GET" && path === "/api/admin/stats") {
        return {
          downloads: { total: 0, perUser: [] },
          feedProcessing: {
            lastPolledAt: null,
            lastDurationMs: null,
            averageDurationMs: null,
            sampleSize: 0,
          },
          runs: [],
          synthesis: {
            total: 2,
            totalBytes: 480,
            defaultDailyEpisodeBudget,
            usersWithoutBudget: 1,
            perUser: [
              {
                userId: "u-1",
                email: "on-default@example.com",
                count: 1,
                bytes: 240,
                todayCount: 1,
                dailyBudget: defaultDailyEpisodeBudget,
                budgetSource: "default",
              },
              {
                userId: "u-2",
                email: "configured@example.com",
                count: 1,
                bytes: 240,
                todayCount: 1,
                dailyBudget: 3,
                budgetSource: "user",
              },
            ],
          },
        };
      }
      return { ok: true };
    },
  });
  await harness.flush();
  return harness;
}

Deno.test("the manage panel shows the effective ceiling, not the word unlimited (audio-feed-umac)", async () => {
  const harness = await consoleOn(7);
  const manage = harness.buttons(harness.byId("usersBody"), "Manage");
  assertEquals(manage.length, 2, "both subscribers must be manageable");

  manage[0]!.click(); // the subscriber with no budget of their own
  await harness.flush();
  assertStringIncludes(textOf(harness.byId("manageDetails")), "Default (7 episodes/day)");

  manage[1]!.click(); // the subscriber whose budget is their own
  await harness.flush();
  const own = textOf(harness.byId("manageDetails"));
  assertStringIncludes(own, "3 episodes/day");
  assertEquals(
    own.includes("Default (7"),
    false,
    "a subscriber with their own budget must not be described by the deployment default",
  );
});

Deno.test("the dashboard says how many subscribers are running on the default (audio-feed-umac)", async () => {
  const harness = await consoleOn(7);
  const caption = harness.byId("synthesisCaption").textContent;
  assertStringIncludes(caption, "1 subscriber has no budget of their own");
  assertStringIncludes(caption, "held to the default ceiling of 7");

  // And the per-subscriber ceiling is in the table the human reads, marked as the default.
  const rows = textOf(harness.byId("synthesisBody"));
  assertStringIncludes(rows, "7 (default)");
  assertStringIncludes(rows, "3");
});
