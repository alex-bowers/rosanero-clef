# Deployment checklist

The app has no sign-in of its own. **Cloudflare Access must be the only way in**, and anyone who gets past it can spend your Workers AI credits. Follow this order so the app is never reachable without Access in front of it.

## Prerequisites

- A Cloudflare account with Workers AI and D1 enabled, and `wrangler` signed in (`pnpm exec wrangler login`).
- A D1 database created for the app, with its ID set in `wrangler.local.jsonc` (see the README's Cloudflare setup steps).
- A domain that is a zone in your Cloudflare account, with DNS managed by Cloudflare. In this document `app.example.com` stands for the address you will use.

## 1. Put Access in front of the subdomain

Create a Zero Trust self-hosted application for `app.example.com` **before** the first deploy. The `routes` entry in the config attaches the custom domain as soon as `wrangler deploy` runs, and Access enforces at Cloudflare's edge as soon as the hostname starts going through Cloudflare.

The application's policy should be an **Allow** rule for your own email address (or another rule you trust). **Do not allow a whole email domain such as `gmail.com`**, which would admit anyone with an address there.

## 2. Deploy

The config turns off `workers_dev` and `preview_urls`, so the only public address is the custom domain in `routes`, which is why Access must exist first. Make sure `wrangler.local.jsonc` has your real hostname and database ID, not the placeholders in [wrangler.jsonc](wrangler.jsonc).

```sh
pnpm test
pnpm db:migrate:remote
pnpm run deploy
```

Use `pnpm run deploy`: plain `pnpm deploy` is a different built-in pnpm command.

Nothing runs on a schedule. Pressing **Fetch new sentences** on the Settings page starts a Cloudflare Workflow (`rosanero-crawl`, created by the deploy) that fetches about the daily sentence cap (20 by default; the cap is checked between articles, so the last article can take it over) from the news site, then rates and translates the sentences. Only one fetch runs at a time.

Your `wrangler.local.jsonc` needs the same `triggers` (an empty `crons` list, which removes the old 05:00 UTC cron) and `workflows` entries as `wrangler.jsonc`. Leaving `triggers` out entirely would keep the old cron.

## 3. Check the subdomain

1. The first deploy creates the DNS record and certificate for the hostname in `routes`. Keep it in `routes` in `wrangler.jsonc` so a later deploy does not drop it. If you would rather add the domain by hand, remove `routes` from your local config, deploy, then add it under **Domains & Routes → Add → Custom domain** in the Worker's **Settings**.
2. **Check that Access is in front of it before using it.** From a terminal that is not signed in:

   ```sh
   curl -sI https://app.example.com/api/health
   ```

   You should get a redirect to a Cloudflare sign-in page (HTTP 302), not `200 OK`. If you get `200`, remove the custom domain straight away (delete `routes` and deploy, or remove it in the dashboard) and fix Access first. The usual cause is that the Access application hostname does not exactly match the domain.
3. If a browser shows `DNS_PROBE_FINISHED_NXDOMAIN` just after a domain is added, it is a stale cached answer. Clear the browser's DNS cache or wait up to 30 minutes.

## 4. Check it works

1. **Watch the logs** with `pnpm exec wrangler tail`. A normal fetch logs `Ingest finished`, `Rating finished`, `Translation finished` and `Cleanup finished`. A step that fails is logged as `<step> failed`, and the next step still runs.
2. **Check a fetch finishes.** Press **Fetch new sentences** and watch the steps change. Runs are also listed in the dashboard under **Workers & Pages → Workflows → rosanero-crawl**.
3. **Check usage** after a day or two, signed in: `/api/usage?days=7` shows requests used today against the limits, and for each model the number of calls, failures, median and 95th-percentile latency, and token counts.
4. **Set a budget alert.** There is no alert for Workers AI alone. In the dashboard go to **Manage Account → Billing → Billable Usage → Create budget alert** and set a low threshold. It covers all usage-based spend on the account and does **not** stop anything: the app's own daily limits are what cap spending. It is available to Pay-as-you-go accounts only, and Cloudflare may already have created a default one, so check the page first.

## If something goes wrong

- **Stop fetching:** set the daily sentence cap to 0 on the Settings page. The button then stays off.
- **Stop all spending quickly:** set `DAILY_ATTEMPT_CAP` and `DAILY_EXPLAIN_CAP` to `"0"` in `wrangler.local.jsonc` and deploy, and set the daily sentence cap to 0 on the Settings page. A cap of 0 also turns the fetch button off, so no rating or translation calls are made.
- **Go back to the previous version:** `pnpm exec wrangler rollback`.

## Known limitations

- The request limits are counted in the database with a check followed by an insert, so two requests at the same instant could both get through. That is acceptable for one user.
- Explanations and ratings come from AI models and can be wrong. The screens say so.
