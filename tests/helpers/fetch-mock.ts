export type FetchHandler = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

const preconnect: typeof fetch.preconnect = () => {};

/** Wrap a fixture handler without permitting speculative network connections. */
export const createFetchMock = (handler: FetchHandler): typeof fetch => {
  function invoke(this: unknown, ...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
    return handler.apply(this, args);
  }
  return Object.assign(invoke, { preconnect });
};
