/**
 * Redis Cache Adapter for persistent OHLCV cache storage
 * Provides persistence layer for CacheManager using Redis
 */

import redis from 'redis';

export class RedisCacheAdapter {
	/**
	 * @param {Object} options - Configuration options
	 * @param {string} options.host - Redis host
	 * @param {number} options.port - Redis port
	 * @param {string} [options.password] - Redis password
	 * @param {number} [options.db] - Redis database number
	 * @param {Object} options.logger - Logger instance
	 */
	constructor(options = {}) {
		this.logger = options.logger;
		this.keyPrefix = 'midas:cache:';
		this.isConnected = false;

		// Redis client configuration
		const redisConfig = {
			socket: {
				host: options.host || 'localhost',
				port: options.port || 6379,
			},
		};

		if (options.password) redisConfig.password = options.password;

		if (options.db !== undefined) redisConfig.database = options.db;

		// Create Redis client (v4+ API)
		this.client = redis.createClient(redisConfig);

		// Event handlers
		this.client.on('error', (err) => {
			this.logger?.error(`Redis Client Error: ${err.message}`);
			this.isConnected = false;
		});

		this.client.on('connect', () => {
			this.logger?.info('Redis cache adapter connecting...');
		});

		this.client.on('ready', () => {
			this.logger?.info('Redis cache adapter ready');
			this.isConnected = true;
		});

		this.client.on('end', () => {
			this.logger?.info('Redis cache adapter disconnected');
			this.isConnected = false;
		});
	}

	/**
	 * Connect to Redis
	 */
	async connect() {
		if (!this.isConnected && !this.client.isOpen) await this.client.connect();
	}

	/**
	 * Disconnect from Redis
	 */
	async disconnect() {
		if (this.client.isOpen) await this.client.quit();
	}

	/**
	 * Get cache segment from Redis
	 * Automatically deserializes bars array back to Map
	 * @param {string} key - Cache key (symbol:timeframe)
	 * @returns {Promise<Object|null>} Cache segment with bars Map or null if not found/expired
	 */
	async get(key) {
		if (!this.isConnected) {
			this.logger?.warn('Redis not connected, skipping cache get');
			return null;
		}

		try {
			const redisKey = this.keyPrefix + key;
			const data = await this.client.get(redisKey);

			if (!data) return null;

			// Deserialize segment
			const segment = JSON.parse(data);

			// Convert bars array back to Map
			if (segment.barsArray) {
				segment.bars = new Map(segment.barsArray);
				delete segment.barsArray;
			}

			return segment;
		} catch (error) {
			this.logger?.error(`Redis get error for ${key}: ${error.message}`);
			return null;
		}
	}

	/**
	 * Set cache segment in Redis
	 * Automatically serializes bars Map to array for JSON storage
	 * Uses SETEX for automatic TTL expiration
	 * @param {string} key - Cache key (symbol:timeframe)
	 * @param {Object} segment - Cache segment with bars Map
	 * @param {number} [ttl] - Time to live in seconds (uses SETEX if provided)
	 * @returns {Promise<void>}
	 */
	async set(key, segment, ttl = null) {
		if (!this.isConnected) {
			this.logger?.warn('Redis not connected, skipping cache set');
			return;
		}

		try {
			const redisKey = this.keyPrefix + key;

			// Serialize segment - convert Map to array for JSON
			const serializable = {
				...segment,
				barsArray: Array.from(segment.bars.entries()),
			};
			delete serializable.bars;

			const data = JSON.stringify(serializable);

			// Set with optional TTL
			if (ttl) await this.client.setEx(redisKey, ttl, data);
			else await this.client.set(redisKey, data);
		} catch (error) {
			this.logger?.error(`Redis set error for ${key}: ${error.message}`);
		}
	}

	/**
	 * Delete cache segment from Redis
	 * @param {string} key - Cache key (symbol:timeframe)
	 * @returns {Promise<void>}
	 */
	async delete(key) {
		if (!this.isConnected) return;

		try {
			const redisKey = this.keyPrefix + key;
			await this.client.del(redisKey);
		} catch (error) {
			this.logger?.error(`Redis delete error for ${key}: ${error.message}`);
		}
	}

	/**
	 * Clear all cache entries matching a pattern
	 * @param {string} [pattern='*'] - Pattern to match keys (e.g., "BTCUSDT:*")
	 * @returns {Promise<number>} Number of keys deleted
	 */
	async clear(pattern = '*') {
		if (!this.isConnected) return 0;

		try {
			const searchPattern = this.keyPrefix + pattern;
			const keys = await this.client.keys(searchPattern);

			if (keys.length === 0) return 0;

			await this.client.del(keys);
			return keys.length;
		} catch (error) {
			this.logger?.error(`Redis clear error: ${error.message}`);
			return 0;
		}
	}

	/**
	 * Get all cache keys from Redis
	 * @returns {Promise<Array<string>>} Array of cache keys with prefix removed (e.g., "BTCUSDT:1h")
	 */
	async keys() {
		if (!this.isConnected) return [];

		try {
			const searchPattern = this.keyPrefix + '*';
			const redisKeys = await this.client.keys(searchPattern);

			// Remove prefix from keys
			return redisKeys.map((key) => key.replace(this.keyPrefix, ''));
		} catch (error) {
			this.logger?.error(`Redis keys error: ${error.message}`);
			return [];
		}
	}

	/**
	 * Get TTL (time to live) for a key in seconds
	 * Uses Redis TTL command
	 * @param {string} key - Cache key (without prefix)
	 * @returns {Promise<number>} TTL in seconds:
	 *   - Positive number: seconds remaining until expiration
	 *   - -1: key exists but has no expiration set
	 *   - -2: key doesn't exist or Redis not connected
	 */
	async getTTL(key) {
		if (!this.isConnected) return -2;

		try {
			const redisKey = this.keyPrefix + key;
			return await this.client.ttl(redisKey);
		} catch (error) {
			this.logger?.error(`Redis TTL error for ${key}: ${error.message}`);
			return -2;
		}
	}

	/**
	 * Save cache statistics to Redis
	 * Automatically adds lastActivity timestamp for freshness validation
	 * @param {Object} stats - Statistics object to persist (hits, misses, etc.)
	 * @returns {Promise<void>}
	 */
	async saveStats(stats) {
		if (!this.isConnected) return;

		try {
			const statsKey = this.keyPrefix + '_stats';
			const data = JSON.stringify({
				...stats,
				lastActivity: Date.now(), // Timestamp of last cache activity
			});
			await this.client.set(statsKey, data);
		} catch (error) {
			this.logger?.error(`Redis saveStats error: ${error.message}`);
		}
	}

	/**
	 * Load cache statistics from Redis
	 * Returns both stats and lastActivity timestamp for freshness validation
	 * @returns {Promise<Object|null>} Object with { stats, lastActivity } or null if not found
	 */
	async loadStats() {
		if (!this.isConnected) return null;

		try {
			const statsKey = this.keyPrefix + '_stats';
			const data = await this.client.get(statsKey);

			if (!data) return null;

			const stats = JSON.parse(data);
			// Keep lastActivity for validation, but remove it from stats object
			const lastActivity = stats.lastActivity;
			delete stats.lastActivity;

			return { stats, lastActivity };
		} catch (error) {
			this.logger?.error(`Redis loadStats error: ${error.message}`);
			return null;
		}
	}
}
