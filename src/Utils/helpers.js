/**
 * Utility Helper Functions
 * Common utilities to reduce code duplication and improve readability
 */

/**
 * Check if an object has keys (more efficient than Object.keys().length)
 * @param {Object} obj - Object to check
 * @returns {boolean}
 */
export function hasKeys(obj) {
	if (!obj || typeof obj !== 'object') return false;
	for (const key in obj) return true;
	return false;
}

/**
 * Parse integer with fallback
 * @param {string|number} value - Value to parse
 * @param {number} fallback - Fallback value if parsing fails
 * @returns {number}
 */
export function parseIntOr(value, fallback) {
	if (value === undefined || value === null) return fallback;
	const parsed = parseInt(value, 10);
	return isNaN(parsed) ? fallback : parsed;
}

/**
 * Parse query parameters for trading endpoints
 * @param {Object} query - Express req.query object
 * @returns {Object} Parsed parameters
 */
export function parseTradingParams(query) {
	return {
		symbol: query.symbol,
		timeframe: query.timeframe || '1h',
		count: parseIntOr(query.count, 200),
		from: query.from ? parseIntOr(query.from) : undefined,
		to: query.to ? parseIntOr(query.to) : undefined,
		bars: parseIntOr(query.bars, 200),
		referenceDate: query.referenceDate || undefined,
	};
}

/**
 * Async route handler wrapper with automatic error handling
 * @param {Function} handler - Async route handler function
 * @returns {Function} Express middleware
 */
export function asyncHandler(handler) {
	return async (req, res, next) => {
		try {
			const result = await handler(req, res);
			if (result !== undefined && !res.headersSent) res.json({ success: true, data: result });
		} catch (error) {
			next(error);
		}
	};
}
