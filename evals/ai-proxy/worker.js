// Dev-only proxy so the eval scripts (which run in Node) can reach the Workers AI binding.
// Run it with `pnpm eval:proxy`. It listens on localhost only and must never be deployed:
// it forwards any request to Workers AI, and Workers AI calls are billed to the account.
export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("POST only", { status: 405 });
    const { model, input } = await request.json();
    const started = Date.now();
    try {
      const result = await env.AI.run(model, input);
      return Response.json({ ok: true, ms: Date.now() - started, result });
    } catch (error) {
      return Response.json({ ok: false, ms: Date.now() - started, message: String(error?.message ?? error) });
    }
  },
};
