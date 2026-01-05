/**
 * Pattern Detector - Optimized Version
 * Uses ATR-based swing detection for robust pattern recognition
 *
 * Features:
 * - Swing-based detection (filters noise via ATR thresholds)
 * - Volume confirmation for breakouts
 * - Unified pattern structure
 * - Pre-calculated indicators from VolatilityEnricher
 */

import { round } from '#utils/statisticalHelpers.js';

export class PatternDetector {
	constructor(options = {}) {
		this.logger = options.logger || console;
	}

	/**
	 * Detect patterns in price action
	 * @param {Object} ohlcvData - OHLCV data with bars array
	 * @param {number} currentPrice - Current market price
	 * @param {Object} volatilityIndicators - Pre-calculated volatility indicators from VolatilityEnricher
	 * @returns {Array|null} Array of detected patterns or null
	 */
	detect({ ohlcvData, currentPrice, volatilityIndicators }) {
		const bars = ohlcvData?.bars;
		if (!bars || bars.length < 30) return null;

		// ATR is required for pattern detection - return null if not available
		if (!volatilityIndicators?.atr?.value) return null;

		const atr = volatilityIndicators.atr.value;
		const avgVolume = this._calculateAvgVolume(bars, 20);

		const patterns = [];

		const detectors = [
			() => this._detectFlag(bars, currentPrice, atr),
			() => this._detectTriangle(bars, atr),
			() => this._detectWedge(bars, atr),
			() => this._detectHeadAndShoulders(bars, atr),
			() => this._detectDouble(bars, atr)
		];

		for (const detector of detectors) {
			const pattern = detector();
			if (!pattern) continue;

			// Volume confirmation
			if (this._confirmVolume(bars, avgVolume, pattern)) {
				pattern.confidence = Math.min(0.95, round(pattern.confidence + 0.05, 2));
				pattern.volume_confirmed = true;
			}

			// Breakout confirmation
			if (this._confirmBreakout(bars, pattern, atr)) {
				pattern.status = 'confirmed';
				pattern.confidence = Math.min(0.95, round(pattern.confidence + 0.1, 2));
				pattern.breakout_confirmed = true;
			}

			// Add ATR context for risk management
			pattern.atr = round(atr, 2);
			if (pattern.invalidation)
				pattern.atr_ratio = round(Math.abs(currentPrice - pattern.invalidation) / atr, 1);

			patterns.push(pattern);
		}

		return patterns.length ? patterns : null;
	}

	/* =========================
	   CORE STRUCTURE
	========================= */

	/**
	 * Find significant swings using ATR filtering
	 * Eliminates noise by requiring swings > minATR multiple
	 */
	_findSwings(bars, atr, minATR = 1.2) {
		const swings = [];

		for (let i = 2; i < bars.length - 2; i++) {
			const h = bars[i].high;
			const l = bars[i].low;

			const isHigh =
				h > bars[i - 1].high &&
				h > bars[i + 1].high &&
				(h - Math.min(bars[i - 1].low, bars[i + 1].low)) > atr * minATR;

			const isLow =
				l < bars[i - 1].low &&
				l < bars[i + 1].low &&
				(Math.max(bars[i - 1].high, bars[i + 1].high) - l) > atr * minATR;

			if (isHigh) swings.push({ type: 'high', price: h, index: i });
			if (isLow) swings.push({ type: 'low', price: l, index: i });
		}

		return swings;
	}

	/**
	 * Calculate average volume
	 */
	_calculateAvgVolume(bars, period = 20) {
		const recent = bars.slice(-period);
		return recent.reduce((a, b) => a + b.volume, 0) / recent.length;
	}

	/* =========================
	   CONFIRMATIONS
	========================= */

	/**
	 * Confirm volume spike
	 * Reversal patterns need stronger volume (1.4x) than continuations (1.2x)
	 */
	_confirmVolume(bars, avgVolume, pattern) {
		const ratio = bars[bars.length - 1].volume / avgVolume;
		return pattern.type === 'reversal' ? ratio > 1.4 : ratio > 1.2;
	}

	/**
	 * Confirm breakout with ATR buffer
	 * Prevents false breakouts from minor price movements
	 */
	_confirmBreakout(bars, pattern, atr) {
		const last = bars[bars.length - 1];

		// Head & Shoulders / Inverse: check neckline break
		if (pattern.neckline !== undefined)
			return Math.abs(last.close - pattern.neckline) > atr * 0.3;

		// Other patterns: check invalidation level with bias
		if (pattern.invalidation !== undefined) {
			if (pattern.bias === 'bullish')
				return last.close > pattern.invalidation + atr * 0.2;
			if (pattern.bias === 'bearish')
				return last.close < pattern.invalidation - atr * 0.2;
		}

		return false;
	}

	/* =========================
	   PATTERNS
	========================= */

	/**
	 * Detect bull or bear flag
	 * Strong pole + consolidation flag
	 */
	_detectFlag(bars, currentPrice, atr) {
		const recent = bars.slice(-30);

		// Dynamic pole search (8-15 bars)
		for (let poleEnd = recent.length - 5; poleEnd >= 15; poleEnd--)
			for (let poleStart = poleEnd - 15; poleStart < poleEnd - 8; poleStart++) {
				const pole = recent.slice(poleStart, poleEnd);
				const poleMove = pole[pole.length - 1].close - pole[0].close;
				const poleRange = Math.abs(poleMove);
				const poleATRMultiple = poleRange / atr;

				// Pole must be at least 3x ATR
				if (poleATRMultiple < 3) continue;

				const bias = poleMove > 0 ? 'bullish' : 'bearish';
				const flag = recent.slice(poleEnd);

				// Flag duration: 5-15 bars
				if (flag.length < 5 || flag.length > 15) continue;

				const flagHigh = Math.max(...flag.map(b => b.high));
				const flagLow = Math.min(...flag.map(b => b.low));
				const flagRange = flagHigh - flagLow;

				// Flag should be smaller than pole (< 50%)
				if (flagRange > poleRange * 0.5) continue;

				// Flag should consolidate, not continue trending
				const flagMove = flag[flag.length - 1].close - flag[0].close;
				if (Math.abs(flagMove) > poleRange * 0.3) continue;

				// Base confidence + bonuses
				let confidence = 0.70;
				if (flag.length >= 8 && flag.length <= 12) confidence += 0.05; // Ideal duration
				if (flagRange < poleRange * 0.3) confidence += 0.05; // Tight flag

				return {
					pattern: bias === 'bullish' ? 'bull flag' : 'bear flag',
					type: 'continuation',
					bias,
					confidence: round(confidence, 2),
					invalidation: bias === 'bullish' ? flagLow : flagHigh,
					target_if_breaks: bias === 'bullish'
						? currentPrice + poleRange
						: currentPrice - poleRange,
					interpretation: `${bias} continuation pattern`,
					pole_duration: pole.length,
					flag_duration: `${flag.length} bars (${flag.length >= 8 && flag.length <= 12 ? 'healthy' : flag.length < 8 ? 'short' : 'extended'})`,
					pole: `${round(pole[0].close, 0)} to ${round(pole[pole.length - 1].close, 0)} (+${round(poleRange, 0)} pts, ${round(poleATRMultiple, 1)}x ATR)`,
					status: 'forming'
				};
			}

		return null;
	}

	/**
	 * Detect triangle patterns
	 * Ascending, descending, or symmetrical based on swing slopes
	 */
	_detectTriangle(bars, atr) {
		const swings = this._findSwings(bars.slice(-60), atr, 1.3);
		const highs = swings.filter(s => s.type === 'high');
		const lows = swings.filter(s => s.type === 'low');

		if (highs.length < 2 || lows.length < 2) return null;

		const highSlope = highs[highs.length - 1].price - highs[0].price;
		const lowSlope = lows[lows.length - 1].price - lows[0].price;

		// Symmetrical triangle: converging lines
		if (highSlope < 0 && lowSlope > 0)
			return {
				pattern: 'symmetrical triangle',
				type: 'continuation',
				bias: 'neutral',
				confidence: 0.65,
				interpretation: 'consolidation pattern',
				upper_bound: round(highs[highs.length - 1].price, 0),
				lower_bound: round(lows[lows.length - 1].price, 0),
				status: 'forming'
			};

		// Ascending triangle: flat top + rising bottom
		if (Math.abs(highSlope) < atr && lowSlope > atr)
			return {
				pattern: 'ascending triangle',
				type: 'continuation',
				bias: 'bullish',
				confidence: 0.70,
				interpretation: 'bullish continuation pattern',
				upper_bound: round(highs[highs.length - 1].price, 0),
				lower_bound: round(lows[lows.length - 1].price, 0),
				invalidation: highs[highs.length - 1].price,
				status: 'forming'
			};

		// Descending triangle: falling top + flat bottom
		if (highSlope < -atr && Math.abs(lowSlope) < atr)
			return {
				pattern: 'descending triangle',
				type: 'continuation',
				bias: 'bearish',
				confidence: 0.70,
				interpretation: 'bearish continuation pattern',
				upper_bound: round(highs[highs.length - 1].price, 0),
				lower_bound: round(lows[lows.length - 1].price, 0),
				invalidation: lows[lows.length - 1].price,
				status: 'forming'
			};

		return null;
	}

	/**
	 * Detect wedge patterns
	 * Both lines sloping in same direction (reversal indicator)
	 */
	_detectWedge(bars, atr) {
		const swings = this._findSwings(bars.slice(-60), atr, 1.3);
		const highs = swings.filter(s => s.type === 'high');
		const lows = swings.filter(s => s.type === 'low');

		if (highs.length < 2 || lows.length < 2) return null;

		const highSlope = highs[highs.length - 1].price - highs[0].price;
		const lowSlope = lows[lows.length - 1].price - lows[0].price;

		// Rising wedge: both rising, lower faster (bearish reversal)
		if (highSlope > 0 && lowSlope > 0 && lowSlope > highSlope)
			return {
				pattern: 'rising wedge',
				type: 'reversal',
				bias: 'bearish',
				confidence: 0.65,
				interpretation: 'bearish reversal pattern (typically breaks down)',
				invalidation: lows[lows.length - 1].price,
				status: 'forming'
			};

		// Falling wedge: both falling, upper faster (bullish reversal)
		if (highSlope < 0 && lowSlope < 0 && lowSlope < highSlope)
			return {
				pattern: 'falling wedge',
				type: 'reversal',
				bias: 'bullish',
				confidence: 0.65,
				interpretation: 'bullish reversal pattern (typically breaks up)',
				invalidation: highs[highs.length - 1].price,
				status: 'forming'
			};

		return null;
	}

	/**
	 * Detect head and shoulders
	 * Three peaks with middle highest and equal shoulders
	 */
	_detectHeadAndShoulders(bars, atr) {
		const swings = this._findSwings(bars.slice(-80), atr, 1.5);
		const highs = swings.filter(s => s.type === 'high');

		if (highs.length < 3) return null;

		const [L, H, R] = highs.slice(-3);

		// Head must be higher than both shoulders
		if (H.price <= L.price || H.price <= R.price) return null;

		// Shoulders must be roughly equal (within 5%)
		if (Math.abs(L.price - R.price) / L.price > 0.05) return null;

		// Find neckline (support between shoulders)
		const neckline = Math.min(
			...bars.slice(L.index, R.index).map(b => b.low)
		);

		return {
			pattern: 'head and shoulders',
			type: 'reversal',
			bias: 'bearish',
			confidence: 0.75,
			interpretation: 'bearish reversal pattern',
			left_shoulder: round(L.price, 0),
			head: round(H.price, 0),
			right_shoulder: round(R.price, 0),
			neckline: round(neckline, 0),
			status: 'forming'
		};
	}

	/**
	 * Detect double top or bottom
	 * Two similar peaks/troughs indicating reversal
	 */
	_detectDouble(bars, atr) {
		const recentBars = bars.slice(-50);
		const offset = bars.length - recentBars.length;
		const swings = this._findSwings(recentBars, atr, 1.3);
		const highs = swings.filter(s => s.type === 'high');
		const lows = swings.filter(s => s.type === 'low');

		// Double top
		if (highs.length >= 2) {
			const [A, B] = highs.slice(-2);

			// Peaks within 2% of each other
			if (Math.abs(A.price - B.price) / A.price < 0.02) {
				// Adjust indices to match original bars array
				const startIdx = A.index + offset;
				const endIdx = B.index + offset;
				const supportLevel = Math.min(
					...bars.slice(startIdx, endIdx + 1).map(b => b.low)
				);

				return {
					pattern: 'double top',
					type: 'reversal',
					bias: 'bearish',
					confidence: 0.65,
					interpretation: 'bearish reversal pattern',
					first_top: round(A.price, 0),
					second_top: round(B.price, 0),
					support_level: round(supportLevel, 0),
					invalidation: round(supportLevel, 0),
					status: 'forming'
				};
			}
		}

		// Double bottom
		if (lows.length >= 2) {
			const [A, B] = lows.slice(-2);

			// Troughs within 2% of each other
			if (Math.abs(A.price - B.price) / A.price < 0.02) {
				// Adjust indices to match original bars array
				const startIdx = A.index + offset;
				const endIdx = B.index + offset;
				const resistanceLevel = Math.max(
					...bars.slice(startIdx, endIdx + 1).map(b => b.high)
				);

				// Invalidation should be below the bottoms, not above
				const invalidationLevel = Math.min(A.price, B.price);

				return {
					pattern: 'double bottom',
					type: 'reversal',
					bias: 'bullish',
					confidence: 0.65,
					interpretation: 'bullish reversal pattern',
					first_bottom: round(A.price, 0),
					second_bottom: round(B.price, 0),
					resistance_level: round(resistanceLevel, 0),
					invalidation: round(invalidationLevel, 0),
					status: 'forming'
				};
			}
		}

		return null;
	}
}

export default PatternDetector;
