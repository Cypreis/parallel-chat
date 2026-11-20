// Keeping many streams healthy: a cap on how many run at once per provider,
// and a few quick retries for the failures that are the service's, not the request's.

function abortError() {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

// At most `max` holders at once, the rest queued in order. max <= 0: no limit.
// acquire(signal) resolves to a release function, or rejects with an AbortError
// when the signal fires while it waits (a cancelled card leaves the queue).
export function createLimiter(max) {
  let active = 0;
  const queue = [];
  const stats = { peak: 0, waited: 0 };
  function release() {
    active -= 1;
    while (queue.length && (max <= 0 || active < max)) {
      const next = queue.shift();
      next.cleanup();
      active += 1;
      stats.peak = Math.max(stats.peak, active);
      next.resolve(once(release));
    }
  }
  const once = (fn) => {
    let done = false;
    return () => {
      if (!done) {
        done = true;
        fn();
      }
    };
  };
  return {
    stats,
    get active() {
      return active;
    },
    get queued() {
      return queue.length;
    },
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(abortError());
      if (max <= 0 || active < max) {
        active += 1;
        stats.peak = Math.max(stats.peak, active);
        return Promise.resolve(once(release));
      }
      stats.waited += 1;
      return new Promise((resolve, reject) => {
        const entry = {
          resolve,
          cleanup: () => signal?.removeEventListener("abort", onAbort),
        };
        const onAbort = () => {
          const i = queue.indexOf(entry);
          if (i >= 0) queue.splice(i, 1);
          reject(abortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        queue.push(entry);
      });
    },
  };
}

// A provider whose streams share a limiter.
export function limitProvider(provider, limiter) {
  return {
    ...provider,
    async *stream(args = {}) {
      const release = await limiter.acquire(args.signal);
      try {
        yield* provider.stream(args);
      } finally {
        release();
      }
    },
  };
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

// Server trouble and overload are worth another try; so is a 429 that says
// when (Retry-After). A plain 429 (a usage limit) and every 4xx are not.
export function retryDelay(res, attempt) {
  const raw = res.headers?.get?.("retry-after");
  const ra = raw === null || raw === undefined || raw === "" ? NaN : Number(raw); // seconds
  if (res.status === 429) return Number.isFinite(ra) && ra >= 0 && ra <= 10 ? ra * 1000 : null;
  if ([500, 502, 503, 504, 529].includes(res.status)) {
    if (Number.isFinite(ra) && ra >= 0 && ra <= 10) return ra * 1000;
    return 300 * 2 ** attempt + Math.random() * 200;
  }
  return null;
}

// doRequest() -> Response. Retried only before any of the body has been read.
export async function withRetry(doRequest, { retries = 0, signal, wait = sleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await doRequest();
    if (res.ok || attempt >= retries) return res;
    const delay = retryDelay(res, attempt);
    if (delay === null) return res;
    await res.body?.cancel?.().catch(() => {});
    await wait(delay, signal);
  }
}
