// Runs clip jobs on a pool of workers, one job per worker at a time, lowest
// priority number first. A job is keyed by country: a new job for the same key
// cancels the old one, whether it is still waiting or already downloading, and
// the old promise resolves to null.
export function createClipQueue(workerCount) {
  const pending = [];
  const jobs = new Map(); // key -> job, for jobs that are waiting or running
  const running = new Map(); // job id -> job
  const idle = [];
  let nextId = 0;

  for (let i = 0; i < workerCount; i++) {
    const worker = new Worker(new URL('./clipWorker.js', import.meta.url));
    worker.onmessage = (e) => {
      const { id, results, error } = e.data;
      const job = running.get(id);
      running.delete(id);
      if (jobs.get(job.key) === job) jobs.delete(job.key);
      if (job.cancelled) job.resolve(null);
      else if (error) job.reject(new Error(error));
      else job.resolve(results);
      idle.push(worker);
      dispatch();
    };
    idle.push(worker);
  }

  function dispatch() {
    while (idle.length && pending.length) {
      let next = 0;
      for (let i = 1; i < pending.length; i++) {
        if (pending[i].priority < pending[next].priority) next = i;
      }
      const [job] = pending.splice(next, 1);
      job.worker = idle.pop();
      running.set(job.message.id, job);
      job.worker.postMessage(job.message);
    }
  }

  function cancel(key) {
    const job = jobs.get(key);
    if (!job) return;
    jobs.delete(key);
    job.cancelled = true;
    if (job.worker) {
      // The worker answers the cancel like any job, which frees it for the next one
      job.worker.postMessage({ cancel: job.message.id });
    } else {
      pending.splice(pending.indexOf(job), 1);
      job.resolve(null);
    }
  }

  return {
    cancel,
    clip(key, url, crop, rings, priority = 0) {
      cancel(key);
      return new Promise((resolve, reject) => {
        // Absolute, since relative URLs in a worker resolve against the worker's own location
        const absoluteUrl = new URL(url, document.baseURI).href;
        const job = { key, priority, resolve, reject, message: { id: nextId++, url: absoluteUrl, crop, rings } };
        jobs.set(key, job);
        pending.push(job);
        dispatch();
      });
    }
  };
}
