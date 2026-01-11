/**
 * Lookback Periods Configuration
 *
 * Centralizes all "magic numbers" for historical data lookback windows
 * used throughout the enrichers and analysis services.
 *
 * RATIONALE: These periods determine how much historical context is used
 * for various calculations. They should be configurable for backtesting
 * and optimization.
 */

/**
 * Statistical analysis periods
 * Used for percentile calculations, mean/std, typical ranges
 */
export const STATISTICAL_PERIODS = {
	short: 20,    // Short-term context (~20 bars)
	medium: 50,   // Medium-term context (~50 bars)
	long: 90      // Long-term context (max used for anomaly detection)
};

/**
 * Trend detection periods
 * Used for slope calculations, trend detection, rate of change
 */
export const TREND_PERIODS = {
	immediate: 5,   // Immediate micro trend (5 bars)
	short: 10,      // Short-term trend (10 bars)
	medium: 20,     // Medium-term trend (20 bars)
	long: 50        // Long-term trend (50 bars)
};

/**
 * Pattern detection periods
 * Used for swing detection, structure analysis
 */
export const PATTERN_PERIODS = {
	swingLookback: 30,     // Bars to look back for swing points
	structureLookback: 80, // Bars to analyze price structure (max used in PatternDetector)
	microPattern: 10,      // Recent bars for micro patterns
	recentAction: 3        // Most recent bars for immediate action
};

/**
 * Volume analysis periods
 */
export const VOLUME_PERIODS = {
	average: 20,        // Volume moving average period
	recentBars: 3,      // Number of recent bars to analyze
	obvTrend: 20,       // OBV trend detection period
	divergence: 10      // Bars for price-volume divergence
};

/**
 * Support/Resistance periods
 */
export const SUPPORT_RESISTANCE_PERIODS = {
	lookback: 50,           // Historical bars for S/R identification
	clusterWindow: 30,      // Window for identifying S/R clusters
	validationBars: 10      // Bars to validate S/R level
};

/**
 * Get lookback period for a specific context
 * @param {string} category - 'statistical', 'trend', 'pattern', 'volume', 'support'
 * @param {string} type - Specific type within category (e.g., 'short', 'medium', 'long')
 * @returns {number} Number of bars to look back
 */
export function getLookbackPeriod(category, type) {
	const categories = {
		statistical: STATISTICAL_PERIODS,
		trend: TREND_PERIODS,
		pattern: PATTERN_PERIODS,
		volume: VOLUME_PERIODS,
		support: SUPPORT_RESISTANCE_PERIODS
	};

	const periods = categories[category];
	if (!periods) {
		throw new Error(`Unknown lookback category: ${category}`);
	}

	if (!(type in periods)) {
		throw new Error(`Unknown type '${type}' in category '${category}'`);
	}

	return periods[type];
}

/**
 * Validation: Ensure lookback periods don't exceed bar counts
 * @param {Object} barCounts - Object with timeframe bar counts
 * @returns {Array<string>} Array of warning messages
 *
 * Note: Only validates medium/full context timeframes (< 1d).
 * Light context timeframes (1d, 1w, 1M) only use basic price action
 * and don't require deep lookback periods.
 */
export function validateLookbackPeriods(barCounts) {
	const warnings = [];

	// Find maximum lookback period used
	const maxLookback = Math.max(
		...Object.values(STATISTICAL_PERIODS),
		...Object.values(TREND_PERIODS),
		...Object.values(PATTERN_PERIODS),
		...Object.values(VOLUME_PERIODS),
		...Object.values(SUPPORT_RESISTANCE_PERIODS)
	);

	// Only validate medium/full context timeframes
	// Light context (1d, 1w, 1M) only uses basic price action
	const mediumFullTimeframes = ['5m', '15m', '30m', '1h', '4h'];

	// Check each timeframe that needs deep lookback
	for (const tf of mediumFullTimeframes) {
		const count = barCounts[tf];
		if (!count) continue;

		if (count < maxLookback) {
			warnings.push(
				`WARNING: ${tf} has ${count} bars but max lookback period is ${maxLookback}. ` +
				`Some calculations may fail or use incomplete data.`
			);
		}
	}

	return warnings;
}

/**
 * Helper: Get all lookback periods as a flat array
 * Useful for understanding the full range of historical requirements
 */
export function getAllLookbackPeriods() {
	return {
		STATISTICAL_PERIODS,
		TREND_PERIODS,
		PATTERN_PERIODS,
		VOLUME_PERIODS,
		SUPPORT_RESISTANCE_PERIODS
	};
}
