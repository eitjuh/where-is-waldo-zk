const jobs = new Map();
let nextId = 1;
const MAX_AGE_MS = 60 * 60 * 1000;

export function startProveJob(runner) {
  const id = String(nextId++);
  const job = {
    id,
    status: "pending",
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
  };
  jobs.set(id, job);
  pruneOldJobs();
  queueMicrotask(() => void runJob(job, runner));
  return id;
}

async function runJob(job, runner) {
  job.status = "running";
  job.startedAt = Date.now();
  try {
    job.result = await runner();
    job.status = "done";
  } catch (error) {
    job.status = "failed";
    job.error = {
      message: error.message ?? "Proof generation failed.",
      code: error.code,
    };
  } finally {
    job.finishedAt = Date.now();
  }
}

export function getProveJob(id) {
  return jobs.get(id) ?? null;
}

export function proveJobPayload(job) {
  const elapsedMs = (job.finishedAt ?? Date.now()) - (job.startedAt ?? job.createdAt);
  const base = {
    job_id: job.id,
    status: job.status,
    elapsed_ms: elapsedMs,
  };
  if (job.status === "done") {
    return { ...base, result: job.result };
  }
  if (job.status === "failed") {
    return { ...base, error: job.error };
  }
  return base;
}

function pruneOldJobs() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [id, job] of jobs) {
    if ((job.finishedAt ?? job.createdAt) < cutoff) {
      jobs.delete(id);
    }
  }
}
