// Private queue consumer for scheduled jobs (vercel.json: the `jobs` topic trigger, fed by `schedules`). Vercel
// Queues consumers have no public URL; only Vercel's queue service can invoke this. See src/jobs/jobs.ts.
import { handleCallback } from "@vercel/queue";
import { retryPolicy, runScheduled } from "../../../jobs/jobs";

export const POST = handleCallback(runScheduled, { retry: retryPolicy });
