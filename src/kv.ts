import { openKv, type Kv } from "#kv";

export type KvOpener = () => Promise<Kv | null>;

let selectedOpener: KvOpener = openKv;
let openPromise: Promise<Kv | null> | null = null;
let openedKv: Kv | null = null;
let nextOpenAttemptAtMs = 0;
let openFailureCount = 0;

/** Install the persistent database before the VPS starts accepting requests. */
export const initializeKv = (kv: Kv): void => {
  if (openedKv || openPromise) throw new Error("KV has already been initialized");
  openedKv = kv;
};

/**
 * Uniform value in `[0, 1)` with the same 53-bit resolution as `Math.random`.
 * The reconnect jitter below is the only consumer: it spreads the retries of
 * independent hosts across time, so predictability costs nothing -- but the
 * platform CSPRNG is free here and keeps a reproducible sequence out of the
 * reconnect schedule.
 */
const randomUnitInterval = (): number => {
  const [high = 0, low = 0] = crypto.getRandomValues(new Uint32Array(2));
  return (high * 2 ** 21 + (low >>> 11)) / 2 ** 53;
};

const retryDelayMs = (failureCount: number): number => {
  const capped = Math.min(5_000, 250 * 2 ** Math.min(5, Math.max(0, failureCount - 1)));
  return Math.trunc(capped * (0.75 + randomUnitInterval() * 0.5));
};

const attemptOpenKv = async (): Promise<Kv | null> => {
  try {
    const kv = await selectedOpener();
    openedKv = kv;
    openFailureCount = 0;
    nextOpenAttemptAtMs = 0;
    return kv;
  } catch (error) {
    openFailureCount += 1;
    nextOpenAttemptAtMs = Date.now() + retryDelayMs(openFailureCount);
    console.error("[ai.ubq.fi] Failed to open KV; a later request will retry:", error);
    return null;
  }
};

export const getKv = (): Promise<Kv | null> => {
  if (openedKv) return Promise.resolve(openedKv);
  if (Date.now() < nextOpenAttemptAtMs) return Promise.resolve(null);
  openPromise ??= attemptOpenKv().finally(() => {
    openPromise = null;
  });
  return openPromise;
};

/** A null fixture disables disk fallback; a supplied opener exercises reconnects. */
export const setKvForTest = (kv: Kv | null, opener?: KvOpener): void => {
  openedKv = kv;
  selectedOpener = opener ?? (() => Promise.resolve(kv));
  openPromise = null;
  openFailureCount = 0;
  nextOpenAttemptAtMs = 0;
};

/** Restore runtime opening after a scoped test has finished. */
export const resetKvForTest = (): void => {
  setKvForTest(null, openKv);
};
