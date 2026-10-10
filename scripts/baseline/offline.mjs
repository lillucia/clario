// Tests may replace fetch with a mock. Real fetch calls from fixture runs may
// only target local fixture servers; in particular, block Content Hub warmup.
const realFetch = globalThis.fetch;
globalThis.fetch = function baselineFetch(input, init) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    return Promise.reject(new Error(`Baseline offline policy blocked external fetch: ${url.origin}`));
  }
  return realFetch(input, init);
};
