// Outside check that the scheduled jobs ran (SPEC Stack, Monitoring). An uptime monitor outside Vercel polls this
// route and alerts the operator when it answers anything but 200. See src/jobs/status.ts.
//
// Public, with no secret: it shows only job names, each job's state and when it last ran. No personal data, counts,
// results or setting values.
import { connection } from "next/server";
import { jobsStatus } from "../../../../jobs/status";

const headers = { "Cache-Control": "no-store" };

export async function GET() {
  await connection(); // always answered at request time, never prerendered or cached
  try {
    const s = await jobsStatus();
    const jobs = Object.fromEntries(
      Object.entries(s.jobs).map(([name, j]) => [name, { state: j.state, lastRunAt: j.lastRunAt }]),
    );
    return Response.json({ ok: s.ok, checkedAt: s.checkedAt, jobs }, { status: s.ok ? 200 : 503, headers });
  } catch (e) {
    console.error("jobs_status: failed:", e instanceof Error ? e.name : "unknown"); // class name only
    return Response.json({ ok: false, error: "unavailable" }, { status: 503, headers });
  }
}
