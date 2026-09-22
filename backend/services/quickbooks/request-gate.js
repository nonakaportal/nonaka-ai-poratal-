// backend/services/quickbooks/request-gate.js
//
// QuickBooks limits how many calls it will answer at once for one
// company. Past that limit it replies 429 — "too many at once, ask
// again in a moment". The portal used to have no idea what to do with
// that answer, so a 429 came back as an ordinary failure and the card
// that lost the race showed "Unable to work out this right now" even
// though nothing was actually wrong.
//
// It was easy to trip, because opening the Overview fired around
// twenty-five calls at the same instant — and twelve of those asked
// for the same Profit & Loss report, each card fetching it for itself
// without knowing another card already had it.
//
// Every read from QuickBooks now goes through here, which does three
// things for each company:
//
//   1. Asks once. Cards wanting the same report share a single call,
//      and the answer is kept for a short while for whoever asks next.
//   2. Queues. A few calls at a time instead of all of them at once.
//   3. Waits when QuickBooks says to wait, instead of giving up.

// How many calls may be in flight at once for a single company.
// QuickBooks does not publish an exact figure and it varies by
// environment, so this is deliberately well under anything observed
// to be refused. The cache means the queue is rarely long anyway.
const MAX_IN_FLIGHT = 3;

// How long an answer stays good for. It has to outlive one page load
// (the Overview takes roughly fifteen seconds to fill) or the sharing
// buys nothing. Everything the portal reads is a report that changes
// when the books change, so a minute-old number is never misleading in
// a way that matters — and no route here writes to QuickBooks.
const CACHE_MS = 60 * 1000;

// Attempt once, then up to three more times if told to wait.
const BACKOFF_MS = [500, 1200, 2500];
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

const MISS = Symbol('cache-miss');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Callers get their own copy. Two cards sharing one call must not be
// able to affect each other by reading the report they were handed.
const copy = value =>
    value === undefined || value === null
        ? value
        : JSON.parse(JSON.stringify(value));

// 429 and 503 both mean "not now, try again" — never "this is wrong".
// Nothing else is retried: a 400 or a 401 would fail again identically
// and retrying would only delay the real error reaching the person.
function saysTryAgain(error) {
    const status = error?.response?.status;

    return status === 429 || status === 503;
}

class RequestGate {
    constructor() {
        // realmId -> { active, waiting: [resolve] }
        this._lanes = new Map();

        // cache key -> { expires, value }
        this._cache = new Map();

        // cache key -> Promise, for calls happening right now
        this._inFlight = new Map();
    }

    // fn does the actual HTTP call. key identifies the question being
    // asked, so identical questions can share one answer.
    async run({ realmId, key, cacheable }, fn) {
        if (cacheable) {
            const cached = this._readCache(key);

            if (cached !== MISS) {
                return copy(cached);
            }

            // Same question already on its way — wait for that answer
            // rather than asking again and spending a second slot.
            const pending = this._inFlight.get(key);

            if (pending) {
                return pending.then(copy);
            }
        }

        const promise = this._attempt(realmId, fn);

        if (cacheable) {
            this._inFlight.set(key, promise);

            promise
                .then(value => {
                    this._cache.set(key, {
                        expires: Date.now() + CACHE_MS,
                        value
                    });

                    this._sweep();
                })
                .catch(() => {
                    // A failed call is not worth remembering.
                })
                .finally(() => {
                    this._inFlight.delete(key);
                });
        }

        return promise.then(copy);
    }

    async _attempt(realmId, fn) {
        let lastError;

        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            if (attempt > 0) {
                // Jitter so a batch that was refused together does not
                // come back in step and get refused together again.
                await sleep(
                    BACKOFF_MS[attempt - 1] +
                    Math.floor(Math.random() * 250)
                );
            }

            await this._acquire(realmId);

            try {
                return await fn();
            } catch (error) {
                lastError = error;

                if (!saysTryAgain(error)) {
                    throw error;
                }

                console.warn(
                    `QuickBooks asked us to wait (attempt ${attempt + 1} of ${MAX_ATTEMPTS})`
                );
            } finally {
                // Released before the wait, so the queue keeps moving
                // while this call is sitting out its backoff.
                this._release(realmId);
            }
        }

        throw lastError;
    }

    _lane(realmId) {
        let lane = this._lanes.get(realmId);

        if (!lane) {
            lane = { active: 0, waiting: [] };
            this._lanes.set(realmId, lane);
        }

        return lane;
    }

    _acquire(realmId) {
        const lane = this._lane(realmId);

        if (lane.active < MAX_IN_FLIGHT) {
            lane.active++;
            return Promise.resolve();
        }

        return new Promise(resolve => lane.waiting.push(resolve));
    }

    _release(realmId) {
        const lane = this._lane(realmId);
        const next = lane.waiting.shift();

        if (next) {
            // Hand the slot straight over rather than dropping the
            // count and raising it again.
            next();
            return;
        }

        lane.active = Math.max(0, lane.active - 1);
    }

    // An expired entry is otherwise only noticed when something asks
    // for that exact key again. Date ranges roll forward every day, so
    // on a server that stays up for weeks the dead keys would pile up
    // quietly. Clear them out once there are enough to be worth it.
    _sweep() {
        if (this._cache.size < 200) {
            return;
        }

        const now = Date.now();

        for (const [key, entry] of this._cache) {
            if (entry.expires <= now) {
                this._cache.delete(key);
            }
        }
    }

    _readCache(key) {
        const entry = this._cache.get(key);

        if (!entry) {
            return MISS;
        }

        if (entry.expires <= Date.now()) {
            this._cache.delete(key);
            return MISS;
        }

        return entry.value;
    }

    // Test seam, and a way to drop everything for one company if a
    // connection is ever replaced mid-process.
    forget(realmId = null) {
        if (!realmId) {
            this._cache.clear();
            return;
        }

        for (const key of this._cache.keys()) {
            if (key.startsWith(`${realmId}|`)) {
                this._cache.delete(key);
            }
        }
    }

    stats() {
        return {
            cached: this._cache.size,
            inFlight: this._inFlight.size,
            lanes: [...this._lanes.entries()].map(([realmId, lane]) => ({
                realmId,
                active: lane.active,
                waiting: lane.waiting.length
            }))
        };
    }
}

module.exports = new RequestGate();
module.exports.RequestGate = RequestGate;
module.exports.MAX_IN_FLIGHT = MAX_IN_FLIGHT;
module.exports.CACHE_MS = CACHE_MS;
