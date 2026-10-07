// The Worker's entry point. The fetch handler lives in app.ts so the tests can import it without
// the Workflow class, which needs the Workers runtime.
export { default } from "./app.ts";
export { CrawlWorkflow } from "./workflow.ts";
