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

		// Connect to Redis
		redisAdapter.connect().catch((err) => {
			this.logger.error('Failed to connect to Redis:', err.message);
			this.cacheManager = null;
		});

		// CacheManager with Redis-only storage
		const cacheTTL = (parameters.redisConfig.ttl || 300) * 1000; // Convert seconds to ms
		this.cacheManager = new CacheManager({
			logger: this.logger,
			maxEntriesPerKey: parameters.redisConfig.maxBars || 10000,
			ttl: cacheTTL,
			redisAdapter: redisAdapter,
		});

		this.logger.info('DataProvider initialized with Redis-only cache');
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
		if (ohlcv.length > this.maxDataPoints) throw new Error(`Data exceeds maximum size (${ohlcv.length} > ${this.maxDataPoints})`);

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
	 * Load OHLCV data for a symbol and timeframe
	 * @param {Object} options - Load options
	 * @param {string} options.symbol - Trading symbol (e.g., 'BTCUSDT')
	 * @param {string} [options.timeframe='1h'] - Timeframe (e.g., '1h', '5m', '1d')
	 * @param {number} [options.count=200] - Number of bars to fetch
	 * @param {number} [options.from] - Start timestamp
	 * @param {number} [options.to] - End timestamp
	 * @param {Date|string|number} [options.analysisDate] - Analysis date for backtesting (bars will end at this date)
	 * @param {boolean} [options.useCache=true] - Use cached data if available
	 * @param {boolean} [options.detectGaps=true] - Detect gaps in data
	 * @returns {Promise<Object>} OHLCV data with metadata
	 * @throws {Error} If symbol is missing or count is out of range
	 */
	async loadOHLCV(options = {}) {
		const { symbol, timeframe = '1h', count = 200, from, to, analysisDate, useCache = true, detectGaps = true } = options;

		if (!symbol) throw new Error('Symbol is required');
		if (count < 1 || count > this.maxDataPoints) throw new Error(`Count must be between 1 and ${this.maxDataPoints}`);

		// Parse analysisDate to timestamp
		let analysisTimestamp = null;
		if (analysisDate) {
			if (analysisDate instanceof Date) analysisTimestamp = analysisDate.getTime();
			else if (typeof analysisDate === 'string') analysisTimestamp = new Date(analysisDate).getTime();
			else if (typeof analysisDate === 'number') analysisTimestamp = analysisDate;

			if (isNaN(analysisTimestamp)) throw new Error(`Invalid analysisDate: ${analysisDate}`);
		}

		const startTime = Date.now();

		// Try to get from CacheManager (Redis)
		if (useCache && this.cacheManager) {
			const cacheResult = await this.cacheManager.get(symbol, timeframe, count, analysisTimestamp);

			if (cacheResult.coverage === 'full') {
				// Full cache hit!
				const duration = Date.now() - startTime;
				this.logger.info(`Cache HIT (full) for ${symbol} (${timeframe}, ${count} bars)${analysisTimestamp ? ` until ${new Date(analysisTimestamp).toISOString()}` : ''}`);

				return {
					symbol,
					timeframe,
					count: cacheResult.bars.length,
					bars: cacheResult.bars,
					firstTimestamp: cacheResult.bars.at(0)?.timestamp ?? null,
					lastTimestamp: cacheResult.bars.at(-1)?.timestamp ?? null,
					analysisDate: analysisTimestamp ? new Date(analysisTimestamp).toISOString() : null,
					gaps: [],
					gapCount: 0,
					fromCache: true,
					loadDuration: duration,
					loadedAt: new Date().toISOString(),
				};
			} else if (cacheResult.coverage === 'partial') {
				// Partial hit - we have some bars, need to fetch missing ones
				this.logger.info(`Cache HIT (partial) for ${symbol} (${timeframe}): have ${cacheResult.bars.length}/${count} bars, fetching missing data`);
				// For now, treat as miss and fetch all data
				// TODO: Implement smart partial fetch
			}
		}

		try {
			// If analysisDate is provided, use it as endTime (to) for Binance API
			const endTime = analysisTimestamp || to;

			const rawData = await this.dataAdapter.fetchOHLC({ symbol, timeframe, count, from, to: endTime });
			this._validateOHLCVData(rawData);
			let cleanedData = this._cleanOHLCVData(rawData);

			// Filter by analysisDate if provided
			if (analysisTimestamp) {
				cleanedData = cleanedData.filter((bar) => bar.timestamp <= analysisTimestamp);

				// If we don't have enough bars, throw an error
				if (cleanedData.length < count)
					throw new Error(`Insufficient historical data: only ${cleanedData.length} bars available before ${new Date(analysisTimestamp).toISOString()}, requested ${count}`);

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
				analysisDate: analysisTimestamp ? new Date(analysisTimestamp).toISOString() : null,
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

			this.logger.info(`Data Loaded : ${symbol} (${timeframe} / ${cleanedData.length}) bars in ${duration}ms${gapInfo}`);

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
