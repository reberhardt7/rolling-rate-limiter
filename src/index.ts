import assert from 'assert';
import microtime from 'microtime';
import { v4 as uuid } from 'uuid';

export type Id = number | string;
export type Seconds = number & { __brand: 'seconds' };
export type Milliseconds = number & { __brand: 'milliseconds' };
export type Microseconds = number & { __brand: 'microseconds' };

/**
 * Generic options for constructing any rate limiter.
 * See `README.md` for more information.
 */
export interface RateLimiterOptions {
  interval: number;
  maxInInterval: number;
  minDifference?: number;
  countBlockedRequests?: boolean;
}

/**
 * Result shape returned by `limitWithInfo` and `wouldLimitWithInfo`.
 * See `README.md` for more information.
 */
export interface RateLimitInfo {
  blocked: boolean;
  blockedDueToCount: boolean;
  blockedDueToMinDifference: boolean;
  millisecondsUntilAllowed: Milliseconds;
  actionsRemaining: number;
}

/**
 * Abstract base class for rate limiters.
 */
export class RateLimiter {
  interval: Microseconds;
  maxInInterval: number;
  minDifference: Microseconds;
  countBlockedRequests: boolean;

  constructor({ interval, maxInInterval, minDifference = 0, countBlockedRequests = true }: RateLimiterOptions) {
    assert(interval > 0, 'Must pass a positive integer for `options.interval`');
    assert(maxInInterval > 0, 'Must pass a positive integer for `options.maxInInterval`');
    assert(minDifference >= 0, '`options.minDifference` cannot be negative');

    this.interval = millisecondsToMicroseconds(interval as Milliseconds);
    this.maxInInterval = maxInInterval;
    this.minDifference = millisecondsToMicroseconds(minDifference as Milliseconds);
    this.countBlockedRequests = countBlockedRequests;
  }

  /**
   * Attempts an action for the provided ID. Return information about whether the action was
   * allowed and why, and whether upcoming actions will be allowed.
   */
  async limitWithInfo(id: Id): Promise<RateLimitInfo> {
    const currentTimestamp = getCurrentMicroseconds();
    const timestamps = await this.getExistingTimestamps(id, currentTimestamp, true);
    return this.calculateInfo(timestamps, currentTimestamp);
  }

  /**
   * Returns information about what would happen if an action were attempted for the provided ID.
   */
  async wouldLimitWithInfo(id: Id): Promise<RateLimitInfo> {
    const currentTimestamp = getCurrentMicroseconds();
    const timestamps = await this.getExistingTimestamps(id, currentTimestamp, false);
    return this.calculateInfo(timestamps, currentTimestamp);
  }

  /**
   * Attempts an action for the provided ID. Returns whether it was blocked.
   */
  async limit(id: Id): Promise<boolean> {
    return (await this.limitWithInfo(id)).blocked;
  }

  /**
   * Returns whether an action for the provided ID would be blocked, if it were attempted.
   */
  async wouldLimit(id: Id): Promise<boolean> {
    return (await this.wouldLimitWithInfo(id)).blocked;
  }

  /**
   * Clears rate limiting state for the provided ID.
   */
  async clear(_id: Id): Promise<void> {
    return Promise.reject(new Error('Not implemented'));
  }

  /**
   * Returns the list of timestamps of actions attempted within `interval` for the provided ID. If
   * `addNewTimestamp` flag is set, adds a new action with the current microsecond timestamp.
   */
  protected async getExistingTimestamps(
    _id: Id,
    _currentTimestamp: Microseconds,
    _addNewTimestamp: boolean,
  ): Promise<Array<Microseconds>> {
    return Promise.reject(new Error('Not implemented'));
  }

  /**
   * Given a list of previous timestamps, computes the RateLimitingInfo. List should not include timestamp for the current action.
   */
  private calculateInfo(previousTimestamps: Array<Microseconds>, currentTimestamp: Microseconds): RateLimitInfo {
    const numPreviousTimestamps = previousTimestamps.length;
    const mostRecentTimestamp = previousTimestamps[numPreviousTimestamps - 1];

    const blockedDueToCount = numPreviousTimestamps >= this.maxInInterval;
    const blockedDueToMinDifference =
      mostRecentTimestamp != null &&
      currentTimestamp - mostRecentTimestamp < this.minDifference;

    const blocked = blockedDueToCount || blockedDueToMinDifference;

    // Always need to wait at least minDistance between consecutive actions.
    // If maxInInterval has been reached, also check how long will be required
    // until the interval is not full anymore.
    const countedTimestamps = this.countBlockedRequests ? [...previousTimestamps, currentTimestamp] : previousTimestamps;
    const microsecondsUntilUnblocked =
      numPreviousTimestamps + 1 >= this.maxInInterval
        ? (countedTimestamps[
          Math.max(0, countedTimestamps.length - this.maxInInterval)
        ] as number) -
        (currentTimestamp as number) +
        (this.interval as number)
        : 0;

    const microsecondsUntilAllowed = Math.max(
      this.minDifference,
      microsecondsUntilUnblocked,
    ) as Microseconds;

    return {
      blocked,
      blockedDueToCount,
      blockedDueToMinDifference,
      millisecondsUntilAllowed: microsecondsToMilliseconds(microsecondsUntilAllowed),
      actionsRemaining: Math.max(0, this.maxInInterval - numPreviousTimestamps - 1),
    };
  }
}

/**
 * Rate limiter implementation that uses an object stored in memory for storage.
 */
export class InMemoryRateLimiter extends RateLimiter {
  storage: Record<Id, Array<number> | undefined>;
  ttls: Record<Id, NodeJS.Timeout | undefined>;

  constructor(options: RateLimiterOptions) {
    super(options);
    this.storage = {};
    this.ttls = {};
  }

  async clear(id: Id) {
    delete this.storage[id];
    const ttl = this.ttls[id];
    if (ttl) {
      clearTimeout(ttl);
      delete this.ttls[id];
    }
  }

  protected async getExistingTimestamps(id: Id, currentTimestamp: Microseconds, addNewTimestamp: boolean) {
    // Update the stored timestamps, including filtering out old ones, and adding the new one.
    const clearBefore = currentTimestamp - this.interval;
    const storedTimestamps = (this.storage[id] || []).filter((t) => t > clearBefore);

    const previousTimestamps = [...storedTimestamps];

    if (addNewTimestamp && (storedTimestamps.length < this.maxInInterval || this.countBlockedRequests)) {
      storedTimestamps.push(currentTimestamp);

      // Set a new TTL, and cancel the old one, if present.
      const ttl = this.ttls[id];
      if (ttl) clearTimeout(ttl);
      this.ttls[id] = setTimeout(() => {
        delete this.storage[id];
        delete this.ttls[id];
      }, microsecondsToMilliseconds(this.interval));
    }

    // Return the new stored timestamps.
    this.storage[id] = storedTimestamps;
    return previousTimestamps as Array<Microseconds>;
  }
}

/**
 * Minimal interface of a Redis client needed for algorithm.
 * Ideally, this would be `RedisClient | IORedisClient`, but that would force consumers of this
 * library to have `@types/redis` and `@types/ioredis` to be installed.
 */
interface RedisClient {
  del(...args: Array<string>): unknown;
  multi(): RedisBatch;
}

/** Minimal interface of a Redis batch command needed for algorithm. */
interface RedisBatch {
  zremrangebyrank(key: string, min: number, max: number): void;
  zremrangebyscore(key: string, min: number, max: number): void;
  zadd(key: string, score: string | number, value: string): void;
  zrange(key: string, min: number, max: number, withScores: unknown): void;
  expire(key: string, time: number): void;
  exec(cb: (err: Error | null, result: Array<unknown>) => void): void;
}

interface RedisRateLimiterOptions extends RateLimiterOptions {
  client: RedisClient;
  namespace: string;
}

/**
 * Rate limiter implementation that uses Redis for storage.
 */
export class RedisRateLimiter extends RateLimiter {
  client: RedisClient;
  namespace: string;
  ttl: number;

  constructor({ client, namespace, ...baseOptions }: RedisRateLimiterOptions) {
    super(baseOptions);
    this.ttl = microsecondsToSeconds(this.interval);
    this.client = client;
    this.namespace = namespace;
  }

  makeKey(id: Id): string {
    return `${this.namespace}${id}`;
  }

  async clear(id: Id) {
    const key = this.makeKey(id);
    await this.client.del(key);
  }

  protected async getExistingTimestamps(
    id: Id,
    currentTimestamp: Microseconds,
    addNewTimestamp: boolean,
  ): Promise<Array<Microseconds>> {
    const key = this.makeKey(id);
    const clearBefore = currentTimestamp - this.interval;

    const batch = this.client.multi();
    batch.zremrangebyscore(key, 0, clearBefore);
    batch.zrange(key, 0, -1, 'WITHSCORES');
    if (addNewTimestamp) {
      batch.zadd(key, String(currentTimestamp), uuid());
      if (!this.countBlockedRequests) {
        // Cap the max size of the set, effectively undoing zadd if the rate
        // limit has been hit
        batch.zremrangebyrank(key, this.maxInInterval, -1);
      }
    }
    batch.expire(key, this.ttl);

    return new Promise((resolve, reject) => {
      batch.exec((err, result) => {
        if (err) return reject(err);

        const zRangeOutput = result[1] as Array<unknown>;
        const zRangeResult = this.getZRangeResult(zRangeOutput);
        const timestamps = this.extractTimestampsFromZRangeResult(zRangeResult);
        return resolve(timestamps);
      });
    });
  }

  private getZRangeResult(zRangeOutput: Array<unknown>) {
    if (!Array.isArray(zRangeOutput[1])) {
      // Standard redis client, regular mode.
      return zRangeOutput as Array<string>;
    } else {
      // ioredis client.
      return zRangeOutput[1] as Array<string>;
    }
  }

  private extractTimestampsFromZRangeResult(zRangeResult: Array<string>) {
    // We only want the stored timestamps, which are the values, or the odd indexes.
    // Map to numbers because by default all returned values are strings.
    return zRangeResult.filter((e, i) => i % 2).map(Number) as Array<Microseconds>;
  }
}

export function getCurrentMicroseconds() {
  return microtime.now() as Microseconds;
}

export function millisecondsToMicroseconds(milliseconds: Milliseconds) {
  return (1000 * milliseconds) as Microseconds;
}

export function microsecondsToMilliseconds(microseconds: Microseconds) {
  return Math.ceil(microseconds / 1000) as Milliseconds;
}

export function microsecondsToSeconds(microseconds: Microseconds) {
  return Math.ceil(microseconds / 1000 / 1000) as Seconds;
}
