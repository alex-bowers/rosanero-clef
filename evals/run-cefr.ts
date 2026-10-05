// Usage: node evals/run-cefr.ts [file.json]   (default: evals/cefr-calibration.json)
// Needs the dev proxy running (`pnpm eval:proxy`). Only items with a non-null "label" are used.
// Environment: AI_PROXY_URL (default http://localhost:8799), MODEL (default @cf/cloudflare/clef-flash).
import { readFileSync } from "node:fs";
import { ClefClient } from "../src/decision/clef.ts";
import { evaluate } from "../src/eval/calibration.ts";
import { CEFR_DESCRIPTIONS, CEFR_INSTRUCTIONS, CEFR_LEVELS, summariseRating } from "../src/rating.ts";

const file = process.argv[2] ?? "evals/cefr-calibration.json";
const proxy = process.env.AI_PROXY_URL ?? "http://localhost:8799";
const model = process.env.MODEL ?? "@cf/cloudflare/clef-flash";

const items: { id: string | number; italian: string; label: string | null }[] = JSON.parse(
  readFileSync(file, "utf8"),
);
const labelled = items.filter((item) => item.label);
if (labelled.length === 0) {
  console.error(`No labelled items in ${file}. Fill in "label" (A1 to C2) for some items first.`);
  process.exit(1);
}

try {
  await fetch(proxy, { method: "GET" }); // any HTTP response, even 405, means the proxy is up
} catch {
  console.error(`The AI proxy is not reachable at ${proxy}.`);
  console.error("Start it in another terminal with `pnpm eval:proxy`, wait for 'Ready', then run this again.");
  process.exit(1);
}

const ai = {
  async run(modelName: string, input: unknown): Promise<unknown> {
    const response = await fetch(proxy, { method: "POST", body: JSON.stringify({ model: modelName, input }) });
    const body = (await response.json()) as { ok: boolean; message?: string; result?: unknown };
    if (!body.ok) throw new Error(body.message ?? "Proxy call failed");
    return body.result;
  },
};
const client = new ClefClient(ai, { model });

const predictions = [];
const started = Date.now();
for (const item of labelled) {
  const distribution = await client.choice({
    state: item.italian,
    instructions: CEFR_INSTRUCTIONS,
    options: [...CEFR_LEVELS],
    descriptions: CEFR_DESCRIPTIONS,
  });
  const rating = summariseRating(distribution);
  predictions.push({ truth: item.label!, distribution });
  const mark = rating.top === item.label ? "ok " : "-- ";
  console.log(
    `${mark}${String(item.id).padEnd(14)} truth ${item.label}  predicted ${rating.top} (${(rating.confidence * 100).toFixed(0)}%)  expected ${rating.expected.toFixed(1)}`,
  );
}

const report = evaluate(predictions);
const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
console.log(`\nModel ${model}: ${report.count} items in ${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log(`Accuracy ${pct(report.accuracy)} | within one level ${pct(report.withinOneLevel)} | mean absolute error ${report.meanAbsoluteError.toFixed(2)} levels | calibration error ${report.expectedCalibrationError.toFixed(2)}`);
console.log("\nConfusion (rows = truth, columns = predicted)");
console.log("     " + CEFR_LEVELS.map((l) => l.padStart(3)).join(" "));
for (const truth of CEFR_LEVELS) {
  console.log(`${truth}   ` + CEFR_LEVELS.map((p) => String(report.confusion[truth][p]).padStart(3)).join(" "));
}
console.log("\nCalibration (does 'N% confident' mean right N% of the time?)");
for (const bin of report.bins.filter((b) => b.count > 0)) {
  console.log(`  confidence ${pct(bin.from)}-${pct(bin.to)}: ${bin.count} items, mean confidence ${pct(bin.meanConfidence)}, accuracy ${pct(bin.accuracy)}`);
}
