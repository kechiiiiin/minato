import { createApp, defaultDeps } from "./app.ts";
import { runCollect } from "./collect.ts";
import { datesToCollect } from "./dates.ts";
import type { Env } from "./env.ts";
import { pruneLog } from "./store.ts";

const app = createApp();

export default {
  fetch: app.fetch,
  // 1時間ごと（wrangler.toml の [triggers]）: 当日分を集める。日付をまたいだ直後（JST 0〜2時台）は前日分も
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const now = defaultDeps.now();
    ctx.waitUntil(
      (async () => {
        await runCollect(env, defaultDeps, datesToCollect(now), "cron");
        await pruneLog(env.DB, now);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
