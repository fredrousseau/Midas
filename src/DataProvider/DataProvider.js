import { CacheManager } from './CacheManager.js';
import { RedisCacheAdapter } from './RedisCacheAdapter.js';
import { timeframeToMs } from '../Utils/timeframe.js';

/**
 * Data provider service for fetching and caching OHLCV market data
 * Uses Redis-only cache with native TTL management
 */
export class DataProvider {
	/**
	 * Create a DataProvider instance
	 * @param {Object} parameters - Configuration parameters
	 * @param {Object} parameters.dataAdapter - Data adapter for fetching market data (e.g., BinanceAdapter)
	 * @param {Object} parameters.logger - Logger instance
	 * @param {number} [parameters.maxDataPoints=5000] - Maximum number of data points per request
	 * @param {Object} [parameters.redisConfig] - Redis configuration object
	 * @param {boolean} [parameters.redisConfig.enabled=false] - Enable Redis cache (if false, all requests hit API)
	 * @param {string} [parameters.redisConfig.host='localhost'] - Redis server host
	 * @param {number} [parameters.redisConfig.port=6379] - Redis server port
	 * @param {string} [parameters.redisConfig.password] - Redis authentication password (optional)
	 * @param {number} [parameters.redisConfig.db=0] - Redis database number (0-15)
	 * @param {number} [parameters.redisConfig.ttl=300] - Cache TTL in seconds (Redis native expiration)
	 * @param {number} [parameters.redisConfig.maxBars=10000] - Max bars per symbol:timeframe (LRU eviction)
	 */
	constructor(parameters = {}) {
		this.dataAdapter = parameters.dataAdapter;
		this.logger = parameters.logger;
		this.maxDataPoints = parameters.maxDataPoints || 5000;

		// Initialize Redis adapter (REQUIRED for cache)
		if (!parameters.redisConfig?.enabled) {
			this.logger.warn('Redis cache disabled - all requests will hit Binance API');
			this.cacheManager = null;
			return;
		}

		const redisAdapter = new RedisCacheAdapter({
			logger: this.logger,
			host: parameters.redisConfig.host,
			port: parameters.redisConfig.port,
			password: parameters.redisConfig.password,
			db: parameters.redisConfig.db,
		});

		// CacheManager with Redis-only storage
		const cacheTTL = (parameters.redisConfig.ttl ?? 300) * 1000; // Convert seconds to ms (0 = no expiry)
		this.cacheManager = new CacheManager({
			logger: this.logger,
			maxEntriesPerKey: parameters.redisConfig.maxBars || 10000,
			ttl: cacheTTL,
			redisAdapter: redisAdapter,
		});

		// Store adapter reference for async connection
		this._redisAdapter = redisAdapter;
		this._connectionPromise = null;
		this._isConnected = false;

		// Start connection asynchronously (non-blocking for backward compatibility)
		this._connectionPromise = this._connectRedis();
	}

	/**
	 * Internal method to connect to Redis
	 * @private
	 * @returns {Promise<boolean>} True if connected successfully
	 */
	async _connectRedis() {
		if (!this._redisAdapter) return false;

		try {
			await this._redisAdapter.connect();
			// Load persisted stats after successful connection
			await this.cacheManager._loadPersistedStats();
			this._isConnected = true;
			this.logger.info('DataProvider initialized with Redis-only cache');
			return true;
		} catch (err) {
			this.logger.error(`Failed to connect to Redis: ${err.message}`);
			this.cacheManager = null;
			this._isConnected = false;
			return false;
		}
	}

	/**
	 * Convert timeframe string to milliseconds
	 * @private
	 * @param {string} timeframe - Timeframe string (e.g., '1h', '5m', '1d')
	 * @returns {number} Timeframe in milliseconds
	 * @throws {Error} If timeframe format is invalid
	 */
	_timeframeToMs(timeframe) {
		return timeframeToMs(timeframe);
	}

	/**
	 * Validate OHLCV data structure and values
	 * @private
	 * @param {Array<Object>} ohlcv - OHLCV data array
	 * @throws {Error} If data is invalid
	 */
	_validateOHLCVData(ohlcv) {
		if (!Array.isArray(ohlcv) || !ohlcv.length) throw new Error('OHLCV data must be a non-empty array');

		const required = ['timestamp', 'open', 'high', 'low', 'close', 'volume'];
		for (let i = 0; i < ohlcv.length; i++) {
			const bar = ohlcv[i];
			if (!bar || typeof bar !== 'object') throw new Error(`Bar ${i} is not a valid object`);

			for (const field of required) if (typeof bar[field] !== 'number' || bar[field] < 0) throw new Error(`Bar ${i}: Invalid ${field}`);

			if (bar.high < bar.low || bar.high < bar.open || bar.high < bar.close || bar.low > bar.open || bar.low > bar.close) throw new Error(`Bar ${i}: Invalid OHLC relationship`);
		}
	}

	/**
	 * Clean OHLCV data by removing duplicates and sorting
	 * @private
	 * @param {Array<Object>} ohlcv - OHLCV data array
	 * @returns {Array<Object>} Cleaned and sorted OHLCV data
	 */
	_cleanOHLCVData(ohlcv) {
		const seen = new Map();
		for (const bar of ohlcv) seen.set(bar.timestamp, bar);
		return Array.from(seen.values()).sort((a, b) => a.timestamp - b.timestamp);
	}

	/**
	 * Detect gaps in OHLCV data timeline
	 * @private
	 * @param {Array<Object>} ohlcv - OHLCV data array
	 * @param {string} timeframe - Timeframe string
	 * @returns {Array<Object>} Array of detected gaps
	 */
	_detectGaps(ohlcv, timeframe) {
		const gaps = [];
		const timeframeMs = this._timeframeToMs(timeframe);
		for (let i = 1; i < ohlcv.length; i++) {
			const expected = ohlcv[i - 1].timestamp + timeframeMs;
			const actual = ohlcv[i].timestamp;
			if (actual !== expected)
				gaps.push({
					before: ohlcv[i - 1].timestamp,
					after: actual,
					expectedBars: Math.round((actual - expected) / timeframeMs),
				});
		}
		return gaps;
	}

	/**
	 * Fetch OHLCV data in multiple batches when count exceeds adapter limit
	 * Works backwards from endTime, fetching batches of size adapterLimit
	 *
	 * @private
	 * @param {Object} options - Fetch options
	 * @param {string} options.symbol - Trading symbol
	 * @param {string} options.timeframe - Timeframe
	 * @param {number} options.count - Total number of bars needed
	 * @param {number} options.from - Start timestamp
	 * @param {number} options.to - End timestamp
	 * @param {number} options.adapterLimit - Maximum bars per API request
	 * @returns {Promise<Array<Object>>} Combined OHLCV data from all batches
	 */
	async _fetchInBatches({ symbol, timeframe, count, from, to, adapterLimit }) {
		const timeframeMs = this._timeframeToMs(timeframe);
		const allBars = [];
		let remainingCount = count;
		let currentEndTime = to;

		// Calculate number of batches needed
		const totalBatches = Math.ceil(count / adapterLimit);
		this.logger.verbose(`Fetching ${count} bars in ${totalBatches} batches (${adapterLimit} bars per batch)`);

		let batchNum = 0;
		while (remainingCount > 0) {
			batchNum++;
			const batchSize = Math.min(remainingCount, adapterLimit);

			this.logger.verbose(`Batch ${batchNum}/${totalBatches}: fetching ${batchSize} bars ending at ${currentEndTime ? new Date(currentEndTime).toISOString() : 'now'}`);

			// Fetch this batch
			const batchData = await this.dataAdapter.fetchOHLC({
				symbol,
				timeframe,
				count: batchSize,
				from,
				to: currentEndTime,
			});

			if (!batchData || batchData.length === 0) {
				this.logger.warn(`Batch ${batchNum}/${totalBatches} returned no data, stopping batch fetch`);
				break;
			}

			// Add to beginning of array (we're working backwards)
			allBars.unshift(...batchData);

			// Update for next batch
			remainingCount -= batchData.length;

			// If we got less than requested, we've hit the data limit
			if (batchData.length < batchSize) {
				this.logger.warn(`Batch ${batchNum}/${totalBatches} returned fewer bars than requested (${batchData.length}/${batchSize}), no more historical data available`);
				break;
			}

			// Calculate the next batch's end time (one bar before the earliest bar we just fetched)
			const earliestTimestamp = batchData.reduce((min, bar) => Math.min(min, bar.timestamp), Infinity);
			currentEndTime = earliestTimestamp - timeframeMs;
		}

		this.logger.info(`Batch fetch complete: received ${allBars.length}/${count} bars in ${batchNum} batches`);

		return allBars;
	}

	/**
	 * Load OHLCV data for a symbol and timeframe
	 * @param {Object} options - Load options
	 * @param {string} options.symbol - Trading symbol (e.g., 'BTCUSDT')
	 * @param {string} [options.timeframe='1h'] - Timeframe (e.g., '1h', '5m', '1d')
	 * @param {number} [options.count=200] - Number of bars to fetch
	 * @param {number} [options.from] - Start timestamp
	 * @param {number} [options.to] - End timestamp
	 * @param {Date|string|number} [options.referenceDate] - Analysis date for historical analysis (bars will end at this date)
	 * @param {boolean} [options.useCache=true] - Use cached data if available
	 * @param {boolean} [options.detectGaps=true] - Detect gaps in data
	 * @returns {Promise<Object>} OHLCV data with metadata
	 * @throws {Error} If symbol is missing or count is out of range
	 */
	async loadOHLCV(options = {}) {
		const { symbol, timeframe = '1h', count = 200, from, to, referenceDate, useCache = true, detectGaps = true } = options;

		if (!symbol) throw new Error('Symbol is required');
		if (count < 1) throw new Error('Count must be at least 1');

		// Parse referenceDate to timestamp
		let analysisTimestamp = null;
		if (referenceDate) {
			if (referenceDate instanceof Date) analysisTimestamp = referenceDate.getTime();
			else if (typeof referenceDate === 'string') analysisTimestamp = new Date(referenceDate).getTime();
			else if (typeof referenceDate === 'number') analysisTimestamp = referenceDate;

			if (isNaN(analysisTimestamp)) throw new Error(`Invalid referenceDate: ${referenceDate}`);
		}

		const startTime = Date.now();

		// Ensure Redis connection is ready before attempting cache operations
		// This awaits any pending connection without blocking if already connected
		if (this._connectionPromise && !this._isConnected) {
			await this._connectionPromise;
			// Log warning if connection failed after waiting
			if (!this._isConnected)
				this.logger.warn('Redis connection failed - proceeding without cache');
		}

		// Try to get from CacheManager (Redis)
		if (useCache && this.cacheManager && this._isConnected) {
			// When referenceDate is provided, adjust cache endTimestamp to only include fully closed bars
			// A bar with open time T is closed at T + timeframeDuration, so last valid open time = referenceDate - duration
			const cacheEndTimestamp = analysisTimestamp ? analysisTimestamp - timeframeToMs(timeframe) : analysisTimestamp;
			const cacheResult = await this.cacheManager.get(symbol, timeframe, count, cacheEndTimestamp);

			if (cacheResult.coverage === 'full') {
				// Full cache hit!
				const duration = Date.now() - startTime;
				this.logger.verbose(`Cache HIT (full) for ${symbol} (${timeframe}, ${count} bars)${analysisTimestamp ? ` until ${new Date(analysisTimestamp).toISOString()}` : ''}`);

				return {
					symbol,
					timeframe,
					count: cacheResult.bars.length,
					bars: cacheResult.bars,
					firstTimestamp: cacheResult.bars.at(0)?.timestamp ?? null,
					lastTimestamp: cacheResult.bars.at(-1)?.timestamp ?? null,
					referenceDate: analysisTimestamp ? new Date(analysisTimestamp).toISOString() : null,
					gaps: [],
					gapCount: 0,
					fromCache: true,
					loadDuration: duration,
					loadedAt: new Date().toISOString(),
				};
			} else if (cacheResult.coverage === 'partial' && cacheResult.bars.length > 0) {
				// Partial hit — fetch only the missing bars
				const cachedBars = cacheResult.bars;
				const missing = cacheResult.missing;
				const missingCount = count - cachedBars.length;
				this.logger.verbose(`Cache HIT (partial) for ${symbol} (${timeframe}): have ${cachedBars.length}/${count} bars, fetching ${missingCount} missing`);

				try {
					let fetchedBars = [];

					// Fetch bars before cached range
					if (missing.before) {
						const beforeCount = Math.ceil((missing.before.end - missing.before.start) / timeframeToMs(timeframe)) + 1;
						const beforeBars = await this.dataAdapter.fetchOHLC({
							symbol, timeframe,
							count: Math.min(beforeCount, missingCount),
							to: missing.before.end,
						});
						fetchedBars = fetchedBars.concat(beforeBars);
					}

					// Fetch bars after cached range
					if (missing.after) {
						const afterCount = Math.ceil((missing.after.end - missing.after.start) / timeframeToMs(timeframe)) + 1;
						const afterBars = await this.dataAdapter.fetchOHLC({
							symbol, timeframe,
							count: Math.min(afterCount, missingCount - fetchedBars.length),
							from: missing.after.start,
						});
						fetchedBars = fetchedBars.concat(afterBars);
					}

					if (fetchedBars.length > 0) 
						// Merge fetched bars into cache
						await this.cacheManager.set(symbol, timeframe, fetchedBars);

					// Combine, dedupe, sort and return
					const allBars = this._cleanOHLCVData([...cachedBars, ...fetchedBars]);
					let finalBars = allBars;

					// Apply referenceDate filter if needed
					if (analysisTimestamp) {
						const tfMs = timeframeToMs(timeframe);
						finalBars = finalBars.filter((bar) => bar.timestamp + tfMs <= analysisTimestamp);
					}

					finalBars = finalBars.slice(-count);
					const duration = Date.now() - startTime;

					return {
						symbol, timeframe,
						count: finalBars.length,
						bars: finalBars,
						firstTimestamp: finalBars.at(0)?.timestamp ?? null,
						lastTimestamp: finalBars.at(-1)?.timestamp ?? null,
						referenceDate: analysisTimestamp ? new Date(analysisTimestamp).toISOString() : null,
						gaps: detectGaps ? this._detectGaps(finalBars, timeframe) : [],
						gapCount: 0,
						fromCache: 'partial',
						loadDuration: duration,
						loadedAt: new Date().toISOString(),
					};
				} catch (_e) {
					// If partial fetch fails, return cached data if usable (>= 50% of requested)
					if (cachedBars.length >= count * 0.5) {
						this.logger.warn(`Smart partial fetch failed for ${symbol} (${timeframe}), returning ${cachedBars.length}/${count} cached bars`);
						const duration = Date.now() - startTime;
						let finalBars = cachedBars;
						if (analysisTimestamp) {
							const tfMs = timeframeToMs(timeframe);
							finalBars = finalBars.filter((bar) => bar.timestamp + tfMs <= analysisTimestamp);
						}
						finalBars = finalBars.slice(-count);
						return {
							symbol, timeframe,
							count: finalBars.length,
							bars: finalBars,
							firstTimestamp: finalBars.at(0)?.timestamp ?? null,
							lastTimestamp: finalBars.at(-1)?.timestamp ?? null,
							referenceDate: analysisTimestamp ? new Date(analysisTimestamp).toISOString() : null,
							gaps: detectGaps ? this._detectGaps(finalBars, timeframe) : [],
							gapCount: 0,
							fromCache: 'partial_degraded',
							loadDuration: duration,
							loadedAt: new Date().toISOString(),
						};
					}
					// Otherwise fall through to full fetch below
					this.logger.warn(`Smart partial fetch failed for ${symbol} (${timeframe}), falling back to full fetch`);
				}
			}
		}

		try {
			// If referenceDate is provided, use it as endTime (to) for Binance API
			const endTime = analysisTimestamp || to;

			// Request extra bars when referenceDate is set, because the filter below
			// may discard the last (still-open) bar, leaving us one bar short
			const fetchCount = analysisTimestamp ? count + 1 : count;

			// BATCH LOADING: Check if count exceeds the configured limit per request
			// Use the smaller of adapter's hard limit and configured maxDataPoints
			const adapterLimit = this.dataAdapter.constructor.MAX_LIMIT || 1000;
			const batchLimit = Math.min(adapterLimit, this.maxDataPoints);
			let rawData;

			if (fetchCount > batchLimit) {
				// Need to fetch in batches
				this.logger.info(`Count ${fetchCount} exceeds batch limit ${batchLimit}, fetching in batches`);
				rawData = await this._fetchInBatches({ symbol, timeframe, count: fetchCount, from, to: endTime, adapterLimit: batchLimit });
			} else {
				// Single request
				rawData = await this.dataAdapter.fetchOHLC({ symbol, timeframe, count: fetchCount, from, to: endTime });
			}

			this._validateOHLCVData(rawData);
			let cleanedData = this._cleanOHLCVData(rawData);

			// Filter by referenceDate if provided
			// Use close time (open + timeframe duration) to ensure only fully closed bars are included
			// bar.timestamp is the open time; a bar is complete when open + duration <= referenceDate
			if (analysisTimestamp) {
				const tfMs = timeframeToMs(timeframe);
				cleanedData = cleanedData.filter((bar) => bar.timestamp + tfMs <= analysisTimestamp);

				// If we don't have enough bars, throw an error
				if (cleanedData.length < count)
					throw new Error(`Insufficient historical data: Symbol ${symbol} for timeframe ${timeframe} only ${cleanedData.length} bars available before ${new Date(analysisTimestamp).toISOString()} requested ${count}`);

				// Take only the last 'count' bars
				cleanedData = cleanedData.slice(-count);
			}

			const gaps = detectGaps ? this._detectGaps(cleanedData, timeframe) : [];
			const duration = Date.now() - startTime;
			const gapInfo = gaps.length > 0 ? ` (${gaps.length} gaps detected)` : '';

			const response = {
				symbol,
				timeframe,
				count: cleanedData.length,
				bars: cleanedData, // Keep raw bars for internal use
				firstTimestamp: cleanedData.at(0)?.timestamp ?? null,
				lastTimestamp: cleanedData.at(-1)?.timestamp ?? null,
				referenceDate: analysisTimestamp ? new Date(analysisTimestamp).toISOString() : null,
				gaps,
				gapCount: gaps.length,
				fromCache: false,
				loadDuration: duration,
				loadedAt: new Date().toISOString(),
			};

			// Store in CacheManager (Redis)
			if (this.cacheManager) {
				await this.cacheManager.set(symbol, timeframe, cleanedData);
				this.logger.verbose(`Stored ${cleanedData.length} bars in Redis cache for ${symbol}:${timeframe}`);
			}

			this.logger.verbose(`Data Loaded : ${symbol} (${timeframe} / ${cleanedData.length}) bars in ${duration}ms${gapInfo}`);

			return response;
		} catch (error) {
			this.logger.error(`Error loading data for ${symbol}: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Clear cache entries
	 * @param {Object} [options={}] - Clear options
	 * @param {string} [options.symbol] - Symbol to clear (clears all if not specified)
	 * @param {string} [options.timeframe] - Timeframe to clear
	 * @returns {number} Number of cache entries removed
	 */
	async clearCache(options = {}) {
		const { symbol, timeframe } = options;

		if (!this.cacheManager) {
			this.logger.warn('Cache is disabled - nothing to clear');
			return 0;
		}

		// Clear CacheManager (Redis)
		const cleared = await this.cacheManager.clear(symbol, timeframe);

		this.logger.info(`Cache cleared (${cleared} items removed)`);
		return cleared;
	}

	/**
	 * Get current price for a symbol
	 * @param {string} symbol - Trading symbol (e.g., 'BTCUSDT')
	 * @returns {Promise<number>} Current price
	 */
	getPrice(symbol) {
		return this.dataAdapter.getPrice(symbol);
	}

	/**
	 * Get available trading pairs
	 * @param {Object} options - Options for filtering pairs
	 * @returns {Promise<Array>} List of available trading pairs
	 */
	getPairs(options) {
		return this.dataAdapter.getPairs(options);
	}

	/**
	 * Search for symbols by name or ticker
	 * @param {string} query - Search term
	 * @param {Object} [options] - Options (e.g., source: 'yahoo'|'binance')
	 * @returns {Promise<Array>} Matching symbols
	 */
	search(query, options) {
		return this.dataAdapter.search(query, options);
	}
	/**
	 * Get cache statistics
	 * @returns {Object} Cache statistics including size, TTL, and item details
	 */
	async getCacheStats() {
		if (!this.cacheManager)
			return {
				version: 'v3-redis-only',
				enabled: false,
				message: 'Redis cache is disabled (set REDIS_ENABLED=true to enable)',
			};

		// Get stats from CacheManager (async because it queries Redis)
		const cacheManagerStats = await this.cacheManager.getStats();

		return {
			enabled: true,
			version: 'v3-redis-only',
			cache: cacheManagerStats,
		};
	}
}
