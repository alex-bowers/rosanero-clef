// Usage: node evals/run-scoring.ts [file.json]   (default: evals/scoring-calibration.json)
// Needs the dev proxy running (`pnpm eval:proxy`). Only items with a non-null "label" are used.
// Environment: AI_PROXY_URL (default http://localhost:8799), MODEL (default @cf/cloudflare/clef-flash).
import { readFileSync } from "node:fs";
import { ClefClient } from "../src/decision/clef.ts";
import { evaluate } from "../src/eval/calibration.ts";
import { tidyAttempt } from "../src/normalise.ts";
import { scoreAttempt, VERDICTS } from "../src/scoring.ts";

const file = process.argv[2] ?? "evals/scoring-calibration.json";
const proxy = process.env.AI_PROXY_URL ?? "http://localhost:8799";
const model = process.env.MODEL ?? "@cf/cloudflare/clef-flash";

interface Item {
  id: string;
  italian: string;
  reference: string;
  attempt: string;
  label: string | null;
}

const labelled = (JSON.parse(readFileSync(file, "utf8")) as Item[]).filter((item) => item.label);
if (labelled.length === 0) {
  console.error(`No labelled items in ${file}. Fill in "label" (${VERDICTS.join(", ")}) first.`);
  process.exit(1);
}

try {
  await fetch(proxy, { method: "GET" }); // any HTTP response, even 405, means the proxy is up
} catch {
  console.error(`The AI proxy is not reachable at ${proxy}.`);
  console.error("Start it in another terminal with `pnpm eval:proxy`, wait for 'Ready', then run this again.");
  process.exit(1);
}

const client = new ClefClient(
  {
    async run(modelName: string, input: unknown): Promise<unknown> {
      const response = await fetch(proxy, { method: "POST", body: JSON.stringify({ model: modelName, input }) });
      const body = (await response.json()) as { ok: boolean; message?: string; result?: unknown };
      if (!body.ok) throw new Error(body.message ?? "Proxy call failed");
      return body.result;
    },
  },
  { model },
);

/** How a learner types on a phone: lower case and no punctuation. The meaning is unchanged. */
const phoneTyped = (text: string) => text.toLowerCase().replace(/[.,;:!?"“”'’]/g, "").replace(/\s+/g, " ").trim();

const acceptable = new Set(["fully_correct", "minor_issue"]);
const predictions = [];
const fluencyByLabel: Record<string, number[]> = {};
let flips = 0;
let flipsAfterTidy = 0;
let acceptabilityFlips = 0;
let acceptabilityFlipsAfterTidy = 0;
let acceptableCorrect = 0;
const started = Date.now();

for (const item of labelled) {
  const normal = await scoreAttempt(client, item);
  const typed = await scoreAttempt(client, { ...item, attempt: phoneTyped(item.attempt) });
  const tidied = await scoreAttempt(client, { ...item, attempt: tidyAttempt(phoneTyped(item.attempt)) });
  predictions.push({ truth: item.label!, distribution: normal.verdict });
  (fluencyByLabel[item.label!] ??= []).push(normal.fluencyScore);

  const flipped = typed.verdictTop !== normal.verdictTop;
  if (flipped) flips++;
  if (tidied.verdictTop !== normal.verdictTop) flipsAfterTidy++;
  if (acceptable.has(typed.verdictTop) !== acceptable.has(normal.verdictTop)) acceptabilityFlips++;
  if (acceptable.has(tidied.verdictTop) !== acceptable.has(normal.verdictTop)) acceptabilityFlipsAfterTidy++;
  if (acceptable.has(normal.verdictTop) === acceptable.has(item.label!)) acceptableCorrect++;

  const mark = normal.verdictTop === item.label ? "ok " : "-- ";
  console.log(
    `${mark}${item.id.padEnd(10)} truth ${item.label!.padEnd(14)} predicted ${normal.verdictTop.padEnd(14)} (${(normal.confidence * 100).toFixed(0)}%)  fluency ${normal.fluencyScore.toFixed(1)}${flipped ? `  FLIPPED when phone-typed -> ${typed.verdictTop}` : ""}`,
  );
}

const report = evaluate(predictions, VERDICTS);
const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
console.log(`\nModel ${model}: ${report.count} items in ${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log(`Exact verdict ${pct(report.accuracy)} | within one step ${pct(report.withinOneLevel)} | calibration error ${report.expectedCalibrationError.toFixed(2)}`);
console.log(`Acceptable (fully/minor) versus not (partly/wrong): ${pct(acceptableCorrect / report.count)} correct`);
console.log(`Typed lower case with no punctuation: verdict changed ${flips} of ${report.count}, acceptable/not changed ${acceptabilityFlips}`);
console.log(`...and after tidyAttempt (capital first letter, final full stop): verdict changed ${flipsAfterTidy}, acceptable/not changed ${acceptabilityFlipsAfterTidy}`);

console.log("\nConfusion (rows = truth, columns = predicted)");
console.log("                " + VERDICTS.map((v) => v.slice(0, 8).padStart(9)).join(""));
for (const truth of VERDICTS) {
  console.log(truth.padEnd(15) + VERDICTS.map((p) => String(report.confusion[truth][p]).padStart(9)).join(""));
}
console.log("\nMean fluency (0 to 4) by labelled verdict");
for (const label of VERDICTS) {
  const values = fluencyByLabel[label];
  if (values) console.log(`  ${label.padEnd(15)} ${(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)}  (n=${values.length})`);
}
console.log("\nCalibration (does 'N% confident' mean right N% of the time?)");
for (const bin of report.bins.filter((b) => b.count > 0)) {
  console.log(`  confidence ${pct(bin.from)}-${pct(bin.to)}: ${bin.count} items, mean confidence ${pct(bin.meanConfidence)}, accuracy ${pct(bin.accuracy)}`);
}
