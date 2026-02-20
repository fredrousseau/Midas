/**
 * Cache Manager for OHLCV data with continuous time-range based caching
 *
 * Design:
 * - One continuous segment per symbol:timeframe
 * - Indexed by timestamp for O(1) access
 * - Automatic extension (prepend/append)
 * - LRU eviction when memory limit reached
 * - Redis-only storage (no memory duplication)
 */

import { timeframeToMs } from '../Utils/timeframe.js';

export class CacheManager {
	/**
	 * @param {Object} options - Configuration options
	 * @param {Object} options.logger - Logger instance
	 * @param {number} [options.maxEntriesPerKey=5000] - Max bars per symbol:timeframe
	 * @param {number} [options.ttl=300000] - Time to live in ms (5 minutes default)
	 * @param {Object} options.redisAdapter - Redis adapter for storage (REQUIRED)
	 */
	constructor(options = {}) {
		this.logger = options.logger;
		this.maxEntriesPerKey = options.maxEntriesPerKey || 5000;
		this.ttl = options.ttl ?? 300000; // 5 minutes (0 = no expiry)
		this.redisAdapter = options.redisAdapter;

		if (!this.redisAdapter) throw new Error('CacheManager requires redisAdapter - cache is now Redis-only');

		// Statistics (will be loaded from Redis once connected)
		this.stats = {
			hits: 0,
			misses: 0,
			partialHits: 0,
			extensions: 0,
			evictions: 0,
			merges: 0,
		};

		// Note: _loadPersistedStats() will be called by DataProvider after Redis connection
		this.logger?.info('CacheManager initialized (Redis-only storage)', {
			maxEntriesPerKey: this.maxEntriesPerKey,
			ttl: this.ttl,
		});
	}

	/**
	 * Generate cache key
	 * @private
	 * @param {string} symbol - Trading symbol
	 * @param {string} timeframe - Timeframe string
	 * @returns {string} Cache key in format "symbol:timeframe"
	 */
	_getCacheKey(symbol, timeframe) {
		return `${symbol}:${timeframe}`;
	}

	/**
	 * Get bars from cache for a specific time range
	 * Uses Redis native TTL for automatic expiration
	 * @param {string} symbol - Trading symbol
	 * @param {string} timeframe - Timeframe
	 * @param {number} count - Number of bars requested
	 * @param {number} [endTimestamp] - End timestamp (default: latest bar in cache)
	 * @returns {Promise<Object>} Result object with coverage status:
	 *   - coverage: 'full'|'partial'|'none'
	 *   - bars: Array of matching bars
	 *   - missing: Missing ranges (for partial/none coverage)
	 */
	async get(symbol, timeframe, count, endTimestamp = null) {
		const key = this._getCacheKey(symbol, timeframe);

		// Get segment from Redis (Redis TTL handles expiration automatically)
		let segment = null;
		try {
			segment = await this.redisAdapter.get(key);
		} catch (error) {
			this.logger?.error(`Failed to get from Redis for ${key}: ${error.message}`);
			await this._incrementStat('misses');
			return { coverage: 'none', bars: [], missing: { count, endTimestamp } };
		}

		if (!segment) {
			await this._incrementStat('misses');
			return { coverage: 'none', bars: [], missing: { count, endTimestamp } };
		}

		// If no endTimestamp specified, use the latest bar in cache
		const requestedEnd = endTimestamp || segment.end;

		// If requestedEnd is before cache start, complete miss
		if (requestedEnd < segment.start) {
			await this._incrementStat('misses');
			return { coverage: 'none', bars: [], missing: { count, endTimestamp: requestedEnd } };
		}

		// Extract all bars from cache start up to requestedEnd, taking last 'count'
		// This avoids assuming continuous bars (stock data has trading hour gaps & weekends)
		const bars = this._extractBars(segment, segment.start, requestedEnd, count);

		if (bars.length === 0) {
			await this._incrementStat('misses');
			return { coverage: 'none', bars: [], missing: { count, endTimestamp: requestedEnd } };
		}

		if (bars.length >= count) {
			await this._incrementStat('hits');
			return { coverage: 'full', bars: bars.slice(-count) };
		}

		// Partial coverage — we have some bars but not enough
		await this._incrementStat('partialHits');
		const timeframeMs = this._parseTimeframe(timeframe);
		const missingBefore = count - bars.length;
		const beforeStart = bars[0].timestamp - missingBefore * timeframeMs;
		const beforeEnd = segment.start - timeframeMs;
		const missing = {
			before: (missingBefore > 0 && beforeStart < beforeEnd)
				? { start: beforeStart, end: beforeEnd }
				: null,
			after: requestedEnd > segment.end
				? { start: segment.end + timeframeMs, end: requestedEnd }
				: null,
		};

		return { coverage: 'partial', bars, missing };
	}

	/**
	 * Store bars in cache
	 * Creates new segment or merges with existing segment
	 * Automatically sets Redis TTL for expiration
	 * @param {string} symbol - Trading symbol
	 * @param {string} timeframe - Timeframe
	 * @param {Array<Object>} bars - Array of OHLCV bars with timestamps
	 * @returns {Promise<void>}
	 */
	async set(symbol, timeframe, bars) {
		if (!bars || bars.length === 0) return;

		const key = this._getCacheKey(symbol, timeframe);

		// Load existing segment from Redis
		let existingSegment = null;
		try {
			existingSegment = await this.redisAdapter.get(key);
		} catch (error) {
			this.logger?.error(`Failed to load from Redis for ${key}: ${error.message}`);
		}

		// Sort bars by timestamp
		const sortedBars = [...bars].sort((a, b) => a.timestamp - b.timestamp);
		const newStart = sortedBars[0].timestamp;
		const newEnd = sortedBars[sortedBars.length - 1].timestamp;

		if (!existingSegment) {
			// Create new segment
			await this._createSegment(key, sortedBars);
			this.logger?.verbose(`Cache created for ${key}: ${sortedBars.length} bars [${new Date(newStart).toISOString()} → ${new Date(newEnd).toISOString()}]`);
			return;
		}

		// Merge with existing segment
		await this._mergeSegment(key, existingSegment, sortedBars);
	}

	/**
	 * Create a new cache segment
	 * @private
	 * @param {string} key - Cache key
	 * @param {Array<Object>} bars - Sorted array of OHLCV bars
	 * @returns {Promise<void>}
	 */
	async _createSegment(key, bars) {
		const barsMap = new Map();
		bars.forEach((bar) => barsMap.set(bar.timestamp, bar));

		const segment = {
			start: bars[0].timestamp,
			end: bars[bars.length - 1].timestamp,
			bars: barsMap,
			count: bars.length,
			createdAt: Date.now(),
		};

		// Save to Redis with TTL (Redis handles expiration automatically)
		// TTL=0 means infinite — pass null so Redis stores without expiration
		const redisTtl = this.ttl > 0 ? Math.floor(this.ttl / 1000) : null;
		try {
			await this.redisAdapter.set(key, segment, redisTtl);
		} catch (error) {
			this.logger?.error(`Failed to persist segment to Redis for ${key}: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Merge new bars with existing segment
	 * Updates segment bounds and persists to Redis with renewed TTL
	 * @private
	 * @param {string} key - Cache key
	 * @param {Object} segment - Existing cache segment
	 * @param {Array<Object>} newBars - Sorted array of new OHLCV bars
	 * @returns {Promise<void>}
	 */
	async _mergeSegment(key, segment, newBars) {
		let merged = 0;
		let extended = false;

		newBars.forEach((bar) => {
			if (!segment.bars.has(bar.timestamp)) {
				segment.bars.set(bar.timestamp, bar);
				segment._sortedTimestamps = null; // Invalidate sorted index
				merged++;

				// Update start/end bounds
				if (bar.timestamp < segment.start) {
					segment.start = bar.timestamp;
					extended = true;
				}
				if (bar.timestamp > segment.end) {
					segment.end = bar.timestamp;
					extended = true;
				}
			}
		});

		segment.count = segment.bars.size;

		if (extended) await this._incrementStat('extensions');

		if (merged > 0) {
			await this._incrementStat('merges');
			this.logger?.verbose(
				`Cache merged for ${key}: added ${merged} bars [${new Date(segment.start).toISOString()} → ${new Date(segment.end).toISOString()}] (total: ${segment.count})`
			);
		}

		// Evict old bars if exceeding limit
		await this._evictOldBars(segment);

		// Save updated segment to Redis (automatically renews TTL)
		// TTL=0 means infinite — pass null so Redis stores without expiration
		if (merged > 0)
			try {
				const redisTtl = this.ttl > 0 ? Math.floor(this.ttl / 1000) : null;
				await this.redisAdapter.set(key, segment, redisTtl);
			} catch (error) {
				this.logger?.error(`Failed to persist merged segment to Redis for ${key}: ${error.message}`);
				throw error;
			}
	}

	/**
	 * Extract bars from segment for a time range
	 * Uses sorted index for O(log n) range lookup instead of O(n) full scan
	 * @private
	 * @param {Object} segment - Cache segment
	 * @param {number} startTimestamp - Start timestamp
	 * @param {number} endTimestamp - End timestamp
	 * @param {number} maxCount - Maximum number of bars to return
	 * @returns {Array<Object>} Array of bars in the specified range
	 */
	_extractBars(segment, startTimestamp, endTimestamp, maxCount) {
		// Build or reuse sorted index
		if (!segment._sortedTimestamps || segment._sortedTimestamps.length !== segment.bars.size) 
			segment._sortedTimestamps = Array.from(segment.bars.keys()).sort((a, b) => a - b);

		const sorted = segment._sortedTimestamps;

		// Binary search for start position
		let lo = 0, hi = sorted.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (sorted[mid] < startTimestamp) lo = mid + 1;
			else hi = mid;
		}

		// Collect bars in range
		const bars = [];
		for (let i = lo; i < sorted.length && sorted[i] <= endTimestamp; i++)
			bars.push(segment.bars.get(sorted[i]));

		// Return last 'maxCount' bars
		return bars.slice(-maxCount);
	}

	/**
	 * Evict oldest bars if segment exceeds max size
	 * Implements LRU eviction strategy
	 * @private
	 * @param {Object} segment - Cache segment to evict from
	 * @returns {Promise<void>}
	 */
	async _evictOldBars(segment) {
		if (segment.count <= this.maxEntriesPerKey) return;

		// Sort timestamps
		const timestamps = Array.from(segment.bars.keys()).sort((a, b) => a - b);

		// Remove oldest bars
		const toRemove = segment.count - this.maxEntriesPerKey;
		for (let i = 0; i < toRemove; i++) segment.bars.delete(timestamps[i]);
		segment._sortedTimestamps = null; // Invalidate sorted index

		// Update segment bounds
		segment.start = timestamps[toRemove];
		segment.count = segment.bars.size;
		await this._incrementStat('evictions', toRemove);

		this.logger?.verbose(`Evicted ${toRemove} old bars from segment (now: ${segment.count} bars)`);
	}

	/**
	 * Parse timeframe string to milliseconds
	 * @private
	 * @param {string} timeframe - Timeframe string (e.g., '1h', '5m', '1d')
	 * @returns {number} Timeframe duration in milliseconds
	 */
	_parseTimeframe(timeframe) {
		return timeframeToMs(timeframe, { throwOnError: false, defaultValue: 3600000 });
	}

	/**
	 * Load persisted statistics from Redis
	 * Validates stats freshness using lastActivity timestamp
	 * Resets stats if they are older than TTL (obsolete)
	 * @private
	 * @returns {Promise<void>}
	 */
	async _loadPersistedStats() {
		try {
			const result = await this.redisAdapter.loadStats();
			if (!result) {
				this.logger?.info('No persisted stats found in Redis - starting fresh');
				return;
			}

			const { stats: persistedStats, lastActivity } = result;

			// Validate stats freshness: check if lastActivity is within TTL window
			const timeSinceLastActivity = Date.now() - lastActivity;
			const ttlMs = this.ttl;

			if (ttlMs > 0 && timeSinceLastActivity > ttlMs) {
				// Stats are obsolete (older than TTL) - cache segments have expired
				this.logger?.warn(`Cache statistics are obsolete (${Math.round(timeSinceLastActivity / 1000)}s old, TTL=${Math.round(ttlMs / 1000)}s) - resetting to zero`);
				// Keep stats at initial values (all zeros)
				return;
			}

			// Stats are fresh - restore them
			this.stats = { ...this.stats, ...persistedStats };
			this.logger?.info('Cache statistics restored from Redis', {
				...this.stats,
				lastActivity: new Date(lastActivity).toISOString(),
				ageSeconds: Math.round(timeSinceLastActivity / 1000),
			});
		} catch (error) {
			this.logger?.error(`Failed to load persisted stats: ${error.message}`);
		}
	}

	/**
	 * Increment a stat counter and persist to Redis
	 * Uses fire-and-forget pattern for non-blocking saves
	 * @private
	 * @param {string} statName - Name of the stat to increment (hits, misses, etc.)
	 * @param {number} [amount=1] - Amount to increment by
	 * @returns {Promise<void>}
	 */
	async _incrementStat(statName, amount = 1) {
		this.stats[statName] += amount;

		// Save stats to Redis (fire-and-forget, non-blocking)
		this.redisAdapter.saveStats(this.stats).catch((err) => {
			this.logger?.error(`Failed to save stats: ${err.message}`);
		});
	}

	/**
	 * Clear cache entries from Redis
	 * @param {string} [symbol] - Optional symbol to clear (clears all if omitted)
	 * @param {string} [timeframe] - Optional timeframe to clear
	 * @returns {Promise<number>} Number of entries cleared
	 */
	async clear(symbol = null, timeframe = null) {
		try {
			if (!symbol) {
				// Clear all Redis cache
				const keys = await this.redisAdapter.keys();
				await this.redisAdapter.clear();
				this.logger?.info(`Redis cache cleared: ${keys.length} entries removed`);
				return keys.length;
			}

			// Clear specific key
			const key = this._getCacheKey(symbol, timeframe);
			await this.redisAdapter.delete(key);
			this.logger?.info(`Cache cleared for ${key}`);
			return 1;
		} catch (error) {
			this.logger?.error(`Failed to clear cache: ${error.message}`);
			return 0;
		}
	}

	/**
	 * Get cache statistics from Redis
	 * Includes hit/miss rates, segment details, and TTL remaining for each entry
	 * @returns {Promise<Object>} Statistics object with entries, totalBars, stats, and config
	 */
	async getStats() {
		const entries = [];
		let totalBars = 0;

		// Get all keys from Redis
		try {
			const keys = await this.redisAdapter.keys();

			// Load each segment to get stats (+ remaining TTL)
			for (const key of keys) {
				// Skip stats key (not a cache segment)
				if (key === '_stats') continue;

				const segment = await this.redisAdapter.get(key);
				const ttlRemaining = await this.redisAdapter.getTTL(key);

				if (segment) {
					totalBars += segment.count;
					entries.push({
						key,
						count: segment.count,
						start: new Date(segment.start).toISOString(),
						end: new Date(segment.end).toISOString(),
						age: Math.round((Date.now() - segment.createdAt) / 1000),
						ttlRemaining: ttlRemaining > 0 ? ttlRemaining : 0, // Seconds remaining before expiration
					});
				}
			}
		} catch (error) {
			this.logger?.error(`Failed to get cache stats from Redis: ${error.message}`);
		}

		const totalRequests = this.stats.hits + this.stats.misses + this.stats.partialHits;
		const hitRate = totalRequests > 0 ? ((this.stats.hits / totalRequests) * 100).toFixed(2) : '0.00';

		return {
			entryCount: entries.length,
			totalBars,
			stats: {
				...this.stats,
				totalRequests,
				hitRate: `${hitRate}%`,
			},
			config: {
				maxEntriesPerKey: this.maxEntriesPerKey,
				ttl: this.ttl === 0 ? 'infinite (no expiry)' : `${this.ttl / 1000}s (${this.ttl / 60000}min)`,
				storage: 'Redis',
				ttlManagement: 'Redis native TTL',
			},
			entries: entries,
		};
	}
}
