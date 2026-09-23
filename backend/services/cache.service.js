/**
 * Simple in-memory request cache with TTL.
 * Prevents duplicate simultaneous API calls to the same endpoint by
 * sharing the in-flight promise across requests.
 *
 * Example:
 *   const result = await cache.memoize(
 *     `qb-${orgId}-cash-projection`,
 *     () => quickbooksService.getCashProjection(orgId),
 *     60000  // Cache for 60 seconds
 *   );
 */

class RequestCache {
  constructor() {
    this.cache = new Map();
    this.inFlight = new Map();
  }

  /**
   * Memoize a request: if it's cached and fresh, return cached result;
   * if it's in-flight, wait for the same promise; otherwise fetch new.
   */
  async memoize(key, fetchFn, ttlMs = 60000) {
    const now = Date.now();

    // Return cached result if still fresh
    if (this.cache.has(key)) {
      const { value, expiresAt } = this.cache.get(key);
      if (expiresAt > now) {
        return value;
      }
      // Expired; remove it
      this.cache.delete(key);
    }

    // If a request for this key is already in flight, wait for it
    // (don't fire another one)
    if (this.inFlight.has(key)) {
      return this.inFlight.get(key);
    }

    // Fire a new request and cache the promise (so concurrent requests share it)
    const promise = fetchFn()
      .then((value) => {
        // Cache the resolved value for future requests
        this.cache.set(key, {
          value,
          expiresAt: now + ttlMs
        });
        this.inFlight.delete(key);
        return value;
      })
      .catch((error) => {
        // Don't cache errors; let the next request retry
        this.inFlight.delete(key);
        throw error;
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  /**
   * Manually invalidate a cache entry (e.g., after data mutation)
   */
  invalidate(key) {
    this.cache.delete(key);
    // Don't delete in-flight promises; let them complete naturally
  }

  /**
   * Clear entire cache (e.g., on logout)
   */
  clear() {
    this.cache.clear();
    this.inFlight.clear();
  }
}

module.exports = new RequestCache();
