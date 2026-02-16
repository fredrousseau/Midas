/**
 * Statistical Helpers
 * Pure functions for statistical calculations
 */

/**
 * Calculate descriptive statistics for a dataset
 * @param {Array<number>} values - Array of numerical values
 * @returns {Object|null} Statistics object or null if insufficient data
 */
export function calculateStats(values) {
	const clean = values.filter(v => v !== null && v !== undefined && !isNaN(v));
	if (clean.length === 0) return null;

	const sum = clean.reduce((a, b) => a + b, 0);
	const mean = sum / clean.length;

	const variance = clean.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / clean.length;
	const std = Math.sqrt(variance);

	return {
		mean,
		std,
		variance,
		min: Math.min(...clean),
		max: Math.max(...clean),
		count: clean.length,
		sum
	};
}

/**
 * Detect trend in a time series using simple linear regression
 * @param {Array<number>} values - Time series values
 * @param {number} threshold - Minimum normalized slope to detect trend (default: 0.001)
 * @returns {Object} Trend information
 */
export function detectTrend(values, threshold = 0.001) {
	const clean = values.filter(v => v !== null && v !== undefined && !isNaN(v));
	if (clean.length < 2)
		return { direction: 'unknown', strength: 0, slope: 0 };

	// Simple linear regression
	const n = clean.length;
	const x = Array.from({ length: n }, (_, i) => i);
	const y = clean;

	const sumX = x.reduce((a, b) => a + b, 0);
	const sumY = y.reduce((a, b) => a + b, 0);
	const sumXY = x.reduce((acc, xi, i) => acc + xi * y[i], 0);
	const sumX2 = x.reduce((acc, xi) => acc + xi * xi, 0);

	// Calculate slope
	const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
	const avgValue = sumY / n;

	// Normalize slope by average value to make it comparable across different scales
	const normalizedSlope = avgValue !== 0 ? slope / avgValue : 0;

	let direction = 'flat';
	if (normalizedSlope > threshold) direction = 'rising';
	else if (normalizedSlope < -threshold) direction = 'declining';

	return {
		direction,
		strength: Math.abs(normalizedSlope),
		slope,
		normalizedSlope
	};
}

/**
 * Round number to specified decimal places
 * @param {number} value - Value to round
 * @param {number} decimals - Number of decimal places
 * @returns {number|null} Rounded value or null if invalid
 */
export function round(value, decimals) {
	if (value === null || value === undefined || isNaN(value)) return null;
	const factor = Math.pow(10, decimals);
	return Math.round(value * factor) / factor;
}
