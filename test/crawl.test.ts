import { test } from "node:test";
import assert from "node:assert/strict";
import type { CrawlWorkflow } from "../src/crawl.ts";
import { handleCrawl } from "../src/crawl.ts";
import { D1Store } from "../src/db.ts";
import { createTestDb } from "./helpers/sqlite-d1.ts";
import { get, quietly, seedChunks } from "./helpers/practice.ts";

const press = () => new Request("https://app.test/api/crawl", { method: "POST" });

function fakeWorkflow(overrides: Partial<CrawlWorkflow> = {}) {
  const started: number[] = [];
  const workflow: CrawlWorkflow = {
    start: async (runId) => (started.push(runId), `instance-${runId}`),
    state: async () => "running",
    ...overrides,
  };
  return { workflow, started };
}

async function send(request: Request, store: D1Store, workflow: CrawlWorkflow) {
  const response = await handleCrawl(request, { store, workflow });
  assert.ok(response);
  return { status: response.status, body: await response.json() };
}

test("pressing the button starts one run and reports it as running", async () => {
  const store = new D1Store(createTestDb());
  const { workflow, started } = fakeWorkflow();

  const { status, body } = await send(press(), store, workflow);
  assert.equal(status, 202);
  assert.deepEqual(started, [1]);
  assert.equal(body.run.status, "running");
  assert.equal(body.reason, "running");
  assert.equal(body.canStart, false);
  assert.deepEqual(body.today, { added: 0, cap: 20, pending: 0 });
  assert.equal((await store.latestCrawlRun())?.instanceId, "instance-1");
});

test("a second press while a run is going does not start another", async () => {
  const store = new D1Store(createTestDb());
  const { workflow, started } = fakeWorkflow();
  await send(press(), store, workflow);

  const { status, body } = await send(press(), store, workflow);
  assert.equal(status, 409);
  assert.match(body.error, /already being fetched/);
  assert.deepEqual(started, [1]);
});

test("the status shows the step in progress, then the sentences added once done", async () => {
  const store = new D1Store(createTestDb());
  const { workflow } = fakeWorkflow();
  await send(press(), store, workflow);

  await store.markCrawlStep(1, "Rating");
  assert.equal((await send(get("/api/crawl"), store, workflow)).body.run.step, "Rating");

  await store.finishCrawlRun(1, "done", [
    { name: "Ingest", ok: true, output: { chunksAdded: 7 } },
    { name: "Rating", ok: true },
  ]);
  const { body } = await send(get("/api/crawl"), store, workflow);
  assert.equal(body.run.status, "done");
  assert.equal(body.run.step, null);
  assert.equal(body.run.complete, true);
  assert.equal(body.run.chunksAdded, 7);
  assert.equal(body.canStart, true);
});

test("a run with a failed step is done but not complete, so the app can offer to retry", async () => {
  const store = new D1Store(createTestDb());
  const { workflow } = fakeWorkflow();
  await send(press(), store, workflow);
  await store.finishCrawlRun(1, "done", [
    { name: "Ingest", ok: false, error: "Error: feed down" },
    { name: "Rating", ok: true },
  ]);

  const { body } = await send(get("/api/crawl"), store, workflow);
  assert.equal(body.run.complete, false);
  assert.equal(body.run.chunksAdded, 0);
  assert.ok(!JSON.stringify(body).includes("feed down"), "error detail stays in the logs");
});

test("the daily sentence cap still limits fetching", async () => {
  const { db, store } = await seedChunks(3);
  await store.updateSettings({ dailyChunkCap: 3 });
  const { workflow, started } = fakeWorkflow();

  const { status, body } = await send(press(), store, workflow);
  assert.equal(status, 409);
  assert.equal(body.reason, "limit");
  assert.match(body.error, /More tomorrow/);
  assert.deepEqual(started, []);

  // Sentences still waiting for a translation can be finished even once the cap is reached.
  db.raw.exec("UPDATE chunks SET reference_en = NULL WHERE position = 0");
  assert.equal((await send(press(), store, workflow)).status, 202);
});

test("a cap of 0 pauses the button", async () => {
  const store = new D1Store(createTestDb());
  await store.updateSettings({ dailyChunkCap: 0 });
  const { workflow, started } = fakeWorkflow();

  const { status, body } = await send(press(), store, workflow);
  assert.equal(status, 409);
  assert.equal(body.reason, "paused");
  assert.deepEqual(started, []);
});

test("a run whose workflow failed to start is marked failed and the button frees up", async () => {
  const store = new D1Store(createTestDb());
  const { workflow } = fakeWorkflow({ start: async () => { throw new Error("no binding"); } });

  const { status } = await quietly(() => send(press(), store, workflow));
  assert.equal(status, 503);
  const { body } = await send(get("/api/crawl"), store, workflow);
  assert.equal(body.run.status, "failed");
  assert.equal(body.canStart, true);
});

test("a run whose workflow errored is marked failed once it has had time to start", async () => {
  const db = createTestDb();
  const store = new D1Store(db);
  const { workflow } = fakeWorkflow({ state: async () => "errored" });
  await send(press(), store, workflow);

  // Too new to check yet.
  assert.equal((await send(get("/api/crawl"), store, workflow)).body.run.status, "running");

  db.raw.exec("UPDATE crawl_runs SET started_at = datetime('now', '-5 minutes')");
  assert.equal((await send(get("/api/crawl"), store, workflow)).body.run.status, "failed");
});

test("a run that never finished is treated as lost after 30 minutes", async () => {
  const db = createTestDb();
  const store = new D1Store(db);
  const { workflow, started } = fakeWorkflow();
  await send(press(), store, workflow);
  db.raw.exec("UPDATE crawl_runs SET started_at = datetime('now', '-31 minutes')");

  assert.equal((await send(get("/api/crawl"), store, workflow)).body.run.status, "failed");
  assert.equal((await send(press(), store, workflow)).status, 202);
  assert.deepEqual(started, [1, 2]);
});

test("other methods are refused", async () => {
  const store = new D1Store(createTestDb());
  const response = await handleCrawl(new Request("https://app.test/api/crawl", { method: "PUT" }), {
    store,
    workflow: fakeWorkflow().workflow,
  });
  assert.equal(response?.status, 405);
  assert.equal(response?.headers.get("allow"), "GET, POST");
  assert.equal(await handleCrawl(get("/api/other"), { store, workflow: fakeWorkflow().workflow }), null);
});
