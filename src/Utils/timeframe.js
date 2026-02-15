/**
 * Timeframe utility functions
 * Shared utilities for parsing and converting timeframe strings
 */

/**
 * Convert a timeframe string to milliseconds
 * @param {string} timeframe - Timeframe string (e.g., '1h', '5m', '1d')
 * @param {Object} options - Options for error handling
 * @param {boolean} [options.throwOnError=true] - If true, throws error on invalid format; if false, returns default value
 * @param {number} [options.defaultValue=3600000] - Default value to return when throwOnError is false (1h by default)
 * @returns {number} Timeframe in milliseconds
 * @throws {Error} If timeframe format is invalid (only when throwOnError is true)
 */
export function timeframeToMs(timeframe, options = {}) {
	const { throwOnError = true, defaultValue = 3600000 } = options;

	const units = {
		m: 60000, // 60 * 1000
		h: 3600000, // 60 * 60 * 1000
		d: 86400000, // 24 * 60 * 60 * 1000
		w: 604800000, // 7 * 24 * 60 * 60 * 1000
		M: 2592000000, // 30 * 24 * 60 * 60 * 1000
	};

	const match = timeframe.match(/^(\d+)([mhdwM])$/);

	if (!match) {
		if (throwOnError) 
			throw new Error(`Invalid timeframe format: ${timeframe}`);
		
		return defaultValue;
	}

	const unitMs = units[match[2]];

	if (!unitMs) {
		if (throwOnError) 
			throw new Error(`Unknown timeframe unit: ${match[2]}`);
		
		return defaultValue;
	}

	return parseInt(match[1]) * unitMs;
}
