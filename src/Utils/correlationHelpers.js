/**
 * Pure statistical functions for correlation analysis.
 */

/**
 * Compute log-returns from an array of close prices.
 * @param {number[]} prices
 * @returns {number[]} array of length (prices.length - 1)
 */
export function logReturns(prices) {
	const out = [];
	for (let i = 1; i < prices.length; i++)
		if (prices[i] > 0 && prices[i - 1] > 0)
			out.push(Math.log(prices[i] / prices[i - 1]));
		else
			out.push(0);

	return out;
}

/**
 * Pearson correlation coefficient between two equal-length numeric arrays.
 * @param {number[]} x
 * @param {number[]} y
 * @returns {number|null} coefficient in [-1, 1], or null if insufficient data / zero variance
 */
export function pearsonCorrelation(x, y) {
	const n = Math.min(x.length, y.length);
	if (n < 2) return null;

	const xs = x.slice(-n);
	const ys = y.slice(-n);

	const meanX = xs.reduce((a, b) => a + b, 0) / n;
	const meanY = ys.reduce((a, b) => a + b, 0) / n;

	let num = 0, varX = 0, varY = 0;
	for (let i = 0; i < n; i++) {
		const dx = xs[i] - meanX;
		const dy = ys[i] - meanY;
		num += dx * dy;
		varX += dx * dx;
		varY += dy * dy;
	}

	const denom = Math.sqrt(varX * varY);
	if (denom === 0) return null;
	return num / denom;
}
