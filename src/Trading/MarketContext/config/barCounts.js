/**
 * Centralized Bar Counts Configuration
 *
 * CRITICAL: All bar counts MUST be synchronized across the system to ensure
 * indicators have sufficient historical data for accurate calculations.
 *
 * OHLCV counts represent the bars fetched from the data provider.
 * INDICATOR counts represent the bars used for indicator calculations.
 * OHLCV counts MUST be >= INDICATOR counts to avoid data gaps.
 */

/**
 * Bar counts for OHLCV data fetching
 * These are used by StatisticalContextService._getAdaptiveOHLCVCount()
 *
 * Rationale:
 * - 5m/15m: 300 bars ≈ 1-3 days (high frequency needs recent data)
 * - 30m: 250 bars ≈ 5 days
 * - 1h: 250 bars ≈ 10 days
 * - 4h: 200 bars ≈ 33 days
 * - 1d: 150 bars ≈ 5 months (sufficient for trend analysis)
 * - 1w: 100 bars ≈ 2 years
 * - 1M: 60 bars ≈ 5 years
 */
export const OHLCV_BAR_COUNTS = {
	'5m': 300,
	'15m': 300,
	'30m': 250,
	'1h': 250,
	'4h': 200,
	'1d': 150,
	'1w': 100,
	'1M': 100,  // Increased from 60 to provide 50+ bars margin for indicators
};

/**
 * Default bar count for OHLCV when timeframe not specified
 */
export const OHLCV_DEFAULT = 250;

/**
 * Bar counts for standard indicator calculations
 * Used by enrichers (Momentum, Volatility, Volume)
 *
 * IMPORTANT: These values are LOWER than OHLCV counts because:
 * 1. Indicators consume data during warmup period
 * 2. Some bars are needed for indicator stabilization
 * 3. The "usable" bars = OHLCV_count - warmup_period
 *
 * Synchronized with OHLCV to ensure sufficient data:
 * - OHLCV 300 → Indicator 200 (100 bars margin for warmup)
 * - OHLCV 250 → Indicator 150 (100 bars margin)
 * - OHLCV 200 → Indicator 150 (50 bars margin)
 * - OHLCV 150 → Indicator 100 (50 bars margin)
 */
export const INDICATOR_BAR_COUNTS = {
	'5m': 200,
	'15m': 200,
	'30m': 200,
	'1h': 150,
	'4h': 150,
	'1d': 100,
	'1w': 60,
	'1M': 50,
};

/**
 * Default bar count for indicators when timeframe not specified
 */
export const INDICATOR_DEFAULT = 150;

/**
 * Bar counts for EMA200 calculations
 * Requires more historical data due to the long period (200)
 *
 * Formula: At least 200 bars + 50 bars margin for warmup
 */
export const EMA200_BAR_COUNTS = {
	'5m': 250,
	'15m': 250,
	'30m': 250,
	'1h': 220,
	'4h': 220,
	'1d': 210,
	'1w': 210,
	'1M': 210,
};

/**
 * Minimum bars required for regime detection
 * Used by RegimeDetectionService
 *
 * Rationale: ADX requires at minimum 2-3x its period (14) for stability
 * 60 bars = ~4x ADX period, provides robust regime classification
 */
export const REGIME_MIN_BARS = 60;

/**
 * Validation: Ensure OHLCV >= INDICATOR for all timeframes
 * This function checks configuration coherence at runtime
 */
export function validateBarCounts() {
	const errors = [];

	for (const tf of Object.keys(OHLCV_BAR_COUNTS)) {
		const ohlcv = OHLCV_BAR_COUNTS[tf];
		const indicator = INDICATOR_BAR_COUNTS[tf];

		if (indicator > ohlcv) {
			errors.push(
				`CRITICAL: ${tf} indicator bars (${indicator}) > OHLCV bars (${ohlcv}). ` +
				`Indicators will have insufficient data!`
			);
		}

		const margin = ohlcv - indicator;
		if (margin < 30) {
			errors.push(
				`WARNING: ${tf} has only ${margin} bars margin between OHLCV and indicator. ` +
				`Recommended minimum: 50 bars for warmup.`
			);
		}
	}

	if (REGIME_MIN_BARS < 50) {
		errors.push(
			`CRITICAL: REGIME_MIN_BARS (${REGIME_MIN_BARS}) is too low. ` +
			`Minimum recommended: 50 for stable regime detection.`
		);
	}

	return errors;
}

/**
 * Get bar count for a specific use case and timeframe
 * @param {string} useCase - 'ohlcv', 'indicator', 'ema200', 'regime'
 * @param {string} timeframe - Timeframe string (e.g., '1h', '1d')
 * @returns {number} Bar count
 */
export function getBarCount(useCase, timeframe) {
	switch (useCase) {
		case 'ohlcv':
			return OHLCV_BAR_COUNTS[timeframe] || OHLCV_DEFAULT;
		case 'indicator':
			return INDICATOR_BAR_COUNTS[timeframe] || INDICATOR_DEFAULT;
		case 'ema200':
			return EMA200_BAR_COUNTS[timeframe] || EMA200_BAR_COUNTS['1h'];
		case 'regime':
			return REGIME_MIN_BARS;
		default:
			throw new Error(`Unknown use case: ${useCase}`);
	}
}

/**
 * Perform validation check on module load
 * Throws errors if critical issues detected
 */
const validationErrors = validateBarCounts();
if (validationErrors.length > 0) {
	const criticalErrors = validationErrors.filter(e => e.startsWith('CRITICAL'));
	if (criticalErrors.length > 0) {
		throw new Error(
			'Bar counts configuration has critical errors:\n' +
			criticalErrors.join('\n')
		);
	}
	// Log warnings but don't throw
	console.warn('Bar counts configuration warnings:\n' + validationErrors.join('\n'));
}
