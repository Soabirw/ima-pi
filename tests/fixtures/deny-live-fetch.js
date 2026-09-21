export const PROVIDER_FREE_FETCH_ERROR = "Network access is disabled in the provider-free core suite.";

export const denyLiveFetch = () => Promise.reject(
  new Error(PROVIDER_FREE_FETCH_ERROR),
);

Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  enumerable: true,
  writable: true,
  value: denyLiveFetch,
});
