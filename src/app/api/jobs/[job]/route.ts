// Scheduled job runner. Vercel Schedules (vercel.json `schedules`, path targets) POST here with
// `Authorization: Bearer $CRON_SECRET`; the operator can run a job by hand the same way. Anything else gets 401.
// Logs and responses carry job names, counts and setting names only (src/jobs/jobs.ts).
import { createHash, timingSafeEqual } from "node:crypto";
import { JOBS } from "../../../../jobs/jobs";

const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
const digest = (s: string) => createHash("sha256").update(s).digest();

function authorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false; // unset in a preview: nothing can run
  const given = req.headers.get("authorization") ?? "";
  return timingSafeEqual(digest(given), digest(`Bearer ${secret}`));
}

export async function POST(req: Request, ctx: { params: Promise<{ job: string }> }) {
  if (!authorized(req)) return new Response("Unauthorized", { status: 401, headers });
  const { job } = await ctx.params;
  const run = Object.hasOwn(JOBS, job) ? JOBS[job] : undefined;
  if (!run) return new Response("Not found", { status: 404, headers });

  const result = await run();
  const line = `job ${job}: ${result.ok ? "ok" : "failed"} ${JSON.stringify(result.steps)}`;
  if (result.ok) console.log(line);
  else console.error(line);
  // A 500 shows the failed run in the schedule's execution history.
  return Response.json(result, { status: result.ok ? 200 : 500, headers });
}
