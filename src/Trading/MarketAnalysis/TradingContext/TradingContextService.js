/**
 * Trading Context Service
 * Generates actionable trading context from statistical analysis:
 * - Market phase determination
 * - Scenario analysis (bullish/bearish/neutral)
 * - Entry strategies
 * - Risk assessment
 * - Trade quality scoring
 * - Actionable recommendations
 */

import { round } from '../../../Utils/statisticalHelpers.js';

export class TradingContextService {
	constructor(parameters = {}) {
		this.logger = parameters.logger || null;

		if (!this.logger) throw new Error('TradingContextService requires a logger instance in options');

		this.logger.info('TradingContextService initialized .');
	}

	/**
	 * Generate trading context from market analysis
	 * @param {Object} marketAnalysis - Complete market analysis from MarketAnalysisService
	 * @returns {Object} Actionable trading context
	 */
	generate(marketAnalysis) {
		const { statistical_context, multi_timeframe_alignment: mtfAlignment } = marketAnalysis;
		const { timeframes, metadata } = statistical_context;

		// Get timeframe data by temporality (no hardcoded timeframes)
		const shortTF = timeframes.short || {};
		const mediumTF = timeframes.medium || {};
		const longTF = timeframes.long || {};

		// Extract current price from the shortest available timeframe (most granular)
		let currentPrice = null;

		// Prioritize short > medium > long for current price
		if (shortTF?.price_action?.current) {
			currentPrice = shortTF.price_action.current;
		} else if (mediumTF?.price_action?.current) {
			currentPrice = mediumTF.price_action.current;
		} else if (longTF?.price_action?.current) {
			currentPrice = longTF.price_action.current;
		}

		if (!currentPrice)
			throw new Error(`Unable to extract current price from timeframe data`);

		const symbol = metadata.symbol;

		// Determine current market phase
		const marketPhase = this._determineMarketPhase(shortTF, mediumTF, longTF, mtfAlignment);

		// Generate scenarios
		const scenarios = this._generateScenarios(shortTF, mediumTF, longTF, currentPrice, mtfAlignment);

		// Generate entry strategies
		const entryStrategies = this._generateEntryStrategies(scenarios, shortTF, mediumTF, currentPrice);

		// Assess risk factors
		const riskFactors = this._assessRiskFactors(shortTF, mediumTF, longTF, mtfAlignment);

		// Calculate trade quality score
		const tradeQuality = this._calculateTradeQuality(shortTF, mediumTF, longTF, mtfAlignment, scenarios, currentPrice);

		// Generate recommendation
		const recommendation = this._generateRecommendation(scenarios, tradeQuality, mtfAlignment);

		return {
			symbol,
			current_market_phase: marketPhase,
			scenario_analysis: scenarios,
			optimal_entry_strategy: entryStrategies,
			risk_factors: riskFactors,
			trade_quality_score: tradeQuality,
			recommended_action: recommendation.action,
			confidence: recommendation.confidence,
			reasoning: recommendation.reasoning
		};
	}

	/**
	 * Determine current market phase with direction awareness
	 * @param {Object} shortTF - Short timeframe data
	 * @param {Object} mediumTF - Medium timeframe data
	 * @param {Object} longTF - Long timeframe data
	 */
	_determineMarketPhase(shortTF, mediumTF, longTF, mtfAlignment) {
		const shortRegime = shortTF.regime?.type || '';
		const mediumRegime = mediumTF.regime?.type || '';
		const longRegime = longTF.regime?.type || '';
		const dominantDirection = mtfAlignment.dominant_direction || 'neutral';

		// Trending phases
		if (mediumRegime.includes('trending') && longRegime.includes('trending')) {
			const direction = dominantDirection === 'bullish' ? 'uptrend' :
			                  dominantDirection === 'bearish' ? 'downtrend' : 'trend';

			if (shortRegime.includes('ranging'))
				return `consolidation within ${direction}`;

			return `strong ${direction}`;
		}

		// Ranging phases
		if (shortRegime.includes('ranging') && mediumRegime.includes('ranging'))
			return 'consolidation';

		// Breakout phases
		if (shortRegime.includes('breakout') || mediumRegime.includes('breakout')) {
			const breakoutDir = shortRegime.includes('bullish') || mediumRegime.includes('bullish') ? 'bullish' :
			                    shortRegime.includes('bearish') || mediumRegime.includes('bearish') ? 'bearish' : '';
			return breakoutDir ? `${breakoutDir} breakout phase` : 'breakout phase';
		}

		// Transition
		if ((shortRegime.includes('trending') && mediumRegime.includes('ranging')) ||
		    (shortRegime.includes('ranging') && mediumRegime.includes('trending')))
			return 'transition phase';

		return 'mixed conditions';
	}

	/**
	 * Generate trading scenarios
	 */
	_generateScenarios(shortTF, mediumTF, longTF, currentPrice, mtfAlignment) {
		// Generate scenarios with raw scores
		const bullish = this._generateBullishScenario(shortTF, mediumTF, longTF, currentPrice, mtfAlignment);
		const bearish = this._generateBearishScenario(shortTF, mediumTF, longTF, currentPrice, mtfAlignment);
		const neutral = this._generateNeutralScenario(shortTF, currentPrice, mtfAlignment);

		// Normalize probabilities so they sum to 1.0
		const totalScore = bullish.rawScore + bearish.rawScore + neutral.rawScore;

		const scenarios = {};
		scenarios.bullish_scenario = {
			...bullish,
			probability: round(bullish.rawScore / totalScore, 2),
			rawScore: undefined // Remove raw score from output
		};

		scenarios.bearish_scenario = {
			...bearish,
			probability: round(bearish.rawScore / totalScore, 2),
			rawScore: undefined
		};

		scenarios.neutral_scenario = {
			...neutral,
			probability: round(neutral.rawScore / totalScore, 2),
			rawScore: undefined
		};

		return scenarios;
	}

	/**
	 * Generate bullish scenario
	 */
	_generateBullishScenario(shortTF, mediumTF, longTF, currentPrice, mtfAlignment) {
		const isBullishAligned = mtfAlignment.dominant_direction === 'bullish';

		// Determine trigger
		let trigger = 'break above resistance';
		if (shortTF.price_action?.breakout_levels?.upside)
			trigger = `Short timeframe break above ${shortTF.price_action.breakout_levels.upside} with volume`;

		// Calculate raw score (not probability yet - will be normalized)
		let rawScore = 40; // Base score
		if (isBullishAligned) rawScore += 20;
		if (mtfAlignment.alignment_score > 0.7) rawScore += 10;
		if (mediumTF.regime?.type?.includes('trending_bullish')) rawScore += 10;
		if (shortTF.micro_patterns?.some(p => p.pattern === 'bull flag')) rawScore += 10;

		// Determine targets
		const targets = this._calculateBullishTargets(shortTF, mediumTF, longTF, currentPrice);

		// Rationale
		const rationale = this._buildBullishRationale(shortTF, mediumTF, longTF, mtfAlignment);

		// Stop loss
		const stopLoss = this._calculateBullishStop(shortTF, mediumTF, currentPrice);

		return {
			trigger,
			rawScore, // Return raw score for normalization
			rationale,
			targets,
			stop_loss: stopLoss
		};
	}

	/**
	 * Generate bearish scenario
	 */
	_generateBearishScenario(shortTF, mediumTF, longTF, currentPrice, mtfAlignment) {
		const isBearishAligned = mtfAlignment.dominant_direction === 'bearish';

		let trigger = 'break below support';
		if (shortTF.price_action?.breakout_levels?.downside)
			trigger = `Short timeframe break below ${shortTF.price_action.breakout_levels.downside} with volume`;

		// Calculate raw score (not probability yet - will be normalized)
		let rawScore = 30; // Base (usually lower if not in downtrend)
		if (isBearishAligned) rawScore += 20;
		if (mtfAlignment.alignment_score > 0.7 && isBearishAligned) rawScore += 10;
		if (mediumTF.regime?.type?.includes('trending_bearish')) rawScore += 10;

		const targets = this._calculateBearishTargets(shortTF, mediumTF, currentPrice);
		const rationale = this._buildBearishRationale(shortTF, mediumTF, mtfAlignment);
		const stopLoss = this._calculateBearishStop(shortTF, mediumTF, currentPrice);

		// Context for counter-trend
		let context = null;
		if (mtfAlignment.dominant_direction === 'bullish')
			context = 'Would be counter-trend (lower probability)';

		return {
			trigger,
			rawScore, // Return raw score for normalization
			rationale,
			targets,
			stop_loss: stopLoss,
			context
		};
	}

	/**
	 * Generate neutral scenario
	 */
	_generateNeutralScenario(shortTF, currentPrice, mtfAlignment) {
		const breakoutLevels = shortTF.price_action?.breakout_levels;

		// Calculate raw score based on how neutral/ranging the market is
		let rawScore = 20; // Base score for neutral scenario
		if (mtfAlignment.dominant_direction === 'neutral' || mtfAlignment.dominant_direction === 'ranging')
			rawScore += 20;

		if (mtfAlignment.alignment_score < 0.4)
			rawScore += 10; // Poor alignment = more likely to stay neutral

		if (!breakoutLevels)
			return {
				condition: 'ranging conditions',
				rawScore,
				action: 'wait for clear direction'
			};

		return {
			condition: `continued range ${breakoutLevels.downside}-${breakoutLevels.upside}`,
			rawScore,
			duration: 'unlikely to persist long',
			action: 'wait for breakout'
		};
	}

	/**
	 * Calculate bullish targets
	 */
	_calculateBullishTargets(shortTF, mediumTF, longTF, currentPrice) {
		const targets = [];

		// Target 1: Near resistance from Medium timeframe
		if (mediumTF.support_resistance?.resistance_levels?.[0]) {
			const level = mediumTF.support_resistance.resistance_levels[0].level;
			targets.push({
				price: level,
				basis: mediumTF.support_resistance.resistance_levels[0].type,
				probability: 0.80
			});
		}

		// Target 2: Pattern projection or next major level
		if (shortTF.micro_patterns?.length > 0) {
			const pattern = shortTF.micro_patterns[0];
			if (pattern.target_if_breaks)
				targets.push({
					price: pattern.target_if_breaks,
					basis: `${pattern.pattern} projection`,
					probability: 0.60
				});

		}

		// Target 3: Major resistance
		if (mediumTF.support_resistance?.resistance_levels?.[1])
			targets.push({
				price: mediumTF.support_resistance.resistance_levels[1].level,
				basis: 'major resistance',
				probability: 0.40
			});

		return targets.slice(0, 3);
	}

	/**
	 * Calculate bearish targets
	 */
	_calculateBearishTargets(shortTF, mediumTF, currentPrice) {
		const targets = [];

		// Target 1: Near support from Medium timeframe
		if (mediumTF.support_resistance?.support_levels?.[0])
			targets.push({
				price: mediumTF.support_resistance.support_levels[0].level,
				basis: mediumTF.support_resistance.support_levels[0].type,
				probability: 0.70
			});

		// Target 2: Major support
		if (mediumTF.support_resistance?.support_levels?.[1])
			targets.push({
				price: mediumTF.support_resistance.support_levels[1].level,
				basis: 'major support',
				probability: 0.45
			});

		return targets;
	}

	/**
	 * Build bullish rationale
	 */
	_buildBullishRationale(shortTF, mediumTF, longTF, mtfAlignment) {
		const reasons = [];

		if (mtfAlignment.dominant_direction === 'bullish')
			reasons.push('HTF trend bullish');

		if (shortTF.micro_patterns?.some(p => p.pattern.includes('bull')))
			reasons.push(shortTF.micro_patterns[0].pattern);

		if (mediumTF.volatility_indicators?.bollinger_bands?.squeeze_detected)
			reasons.push('BB squeeze');

		if (mediumTF.volume_indicators?.obv?.interpretation?.includes('supporting'))
			reasons.push('volume confirmation');

		return reasons.join(' + ');
	}

	/**
	 * Build bearish rationale
	 */
	_buildBearishRationale(shortTF, mediumTF, mtfAlignment) {
		const reasons = [];

		if (mtfAlignment.dominant_direction === 'bearish')
			reasons.push('HTF trend bearish');

		if (shortTF.price_action?.bar_type?.includes('bearish'))
			reasons.push('bearish price action');

		return reasons.length > 0 ? reasons.join(' + ') : 'counter-trend setup';
	}

	/**
	 * Calculate bullish stop
	 */
	_calculateBullishStop(shortTF, mediumTF, currentPrice) {
		// Use recent support or pattern invalidation
		let stopPrice = currentPrice * 0.97; // Default 3% stop

		if (shortTF.micro_patterns?.length > 0 && shortTF.micro_patterns[0].invalidation)
			stopPrice = shortTF.micro_patterns[0].invalidation;
		 else if (mediumTF.moving_averages?.ema?.ema26)
			stopPrice = mediumTF.moving_averages.ema.ema26;

		return {
			price: round(stopPrice, 0),
			basis: 'below key support'
		};
	}

	/**
	 * Calculate bearish stop
	 */
	_calculateBearishStop(shortTF, mediumTF, currentPrice) {
		let stopPrice = currentPrice * 1.03; // Default 3% stop

		if (mediumTF.moving_averages?.ema?.ema26)
			stopPrice = mediumTF.moving_averages.ema.ema26;

		return {
			price: round(stopPrice, 0),
			basis: 'above resistance'
		};
	}

	/**
	 * Generate entry strategies
	 */
	_generateEntryStrategies(scenarios, shortTF, mediumTF, currentPrice) {
		const strategies = {};

		// Primary strategy (highest probability scenario)
		const bullishProb = scenarios.bullish_scenario?.probability || 0;
		const bearishProb = scenarios.bearish_scenario?.probability || 0;

		if (bullishProb > bearishProb)
			strategies.primary = this._buildBreakoutStrategy('bullish', scenarios.bullish_scenario, currentPrice);
		 else
			strategies.primary = this._buildBreakoutStrategy('bearish', scenarios.bearish_scenario, currentPrice);

		// Alternative strategy
		strategies.alternative = this._buildRetestStrategy(shortTF, mediumTF, currentPrice);

		return strategies;
	}

	/**
	 * Build breakout strategy
	 */
	_buildBreakoutStrategy(direction, scenario, currentPrice) {
		if (!scenario || !scenario.targets || scenario.targets.length === 0) 
			return null;

		const target1 = scenario.targets[0];
		const target2 = scenario.targets[1] || target1;
		const stop = scenario.stop_loss;

		// Calculate risk/reward
		const risk = Math.abs(currentPrice - stop.price);
		const reward = Math.abs(target1.price - currentPrice);
		const rr = risk > 0 ? reward / risk : 0;

		return {
			type: 'breakout',
			direction,
			level: target1.price,
			confirmation: 'close above + volume > avg',
			entry: round(currentPrice * (direction === 'bullish' ? 1.001 : 0.999), 0),
			stop: stop.price,
			target1: target1.price,
			target2: target2?.price || target1.price,
			risk_reward: `1:${round(rr, 1)}`,
			position_size: 'normal'
		};
	}

	/**
	 * Build retest strategy
	 */
	_buildRetestStrategy(shortTF, mediumTF, currentPrice) {
		const supportLevels = mediumTF.support_resistance?.support_levels || [];

		if (supportLevels.length === 0) return null;

		const support = supportLevels[0];
		const entry = support.level;
		const stop = entry * 0.985; // 1.5% below
		const target1 = currentPrice;
		const target2 = currentPrice * 1.02;

		const risk = entry - stop;
		const reward = target2 - entry;
		const rr = risk > 0 ? reward / risk : 0;

		return {
			type: 'retest',
			level: entry,
			confirmation: 'hold + bullish rejection pattern',
			entry: round(entry, 0),
			stop: round(stop, 0),
			target1: round(target1, 0),
			target2: round(target2, 0),
			risk_reward: `1:${round(rr, 1)}`,
			position_size: 'normal'
		};
	}

	/**
	 * Assess risk factors
	 */
	_assessRiskFactors(shortTF, mediumTF, longTF, mtfAlignment) {
		const risks = [];

		// MTF conflicts
		if (mtfAlignment.conflicts && mtfAlignment.conflicts.length > 0)
			risks.push({
				factor: 'MTF conflicts',
				impact: mtfAlignment.conflicts[0].severity || 'medium',
				mitigation: 'Wait for alignment or reduce position size'
			});

		// Consolidation duration
		if (shortTF.regime?.type?.includes('ranging'))
			risks.push({
				factor: 'Short timeframe consolidation',
				impact: 'low',
				mitigation: 'Pattern typically resolves quickly'
			});

		// Divergences
		if (shortTF.momentum_indicators?.rsi?.divergence?.includes('divergence'))
			risks.push({
				factor: 'RSI divergence',
				impact: 'medium',
				mitigation: 'Watch for momentum confirmation'
			});

		return risks.length > 0 ? risks : null;
	}

	/**
	 * Calculate trade quality score
	 */
	_calculateTradeQuality(shortTF, mediumTF, longTF, mtfAlignment, scenarios, currentPrice) {
		const scores = {};

		// Trend alignment (0-1)
		scores.trend_alignment = mtfAlignment.alignment_score || 0.5;

		// Momentum (0-1)
		let momentumScore = 0.5;
		if (mediumTF.momentum_indicators?.rsi?.value) {
			const rsi = mediumTF.momentum_indicators.rsi.value;
			if (rsi > 50 && rsi < 70) momentumScore = 0.80;
			else if (rsi > 40 && rsi < 80) momentumScore = 0.65;
			else momentumScore = 0.40;
		}
		scores.momentum = momentumScore;

		// Volume (0-1)
		let volumeScore = 0.5;
		if (mediumTF.volume_indicators?.volume?.interpretation?.includes('good'))
			volumeScore = 0.75;
		 else if (mediumTF.volume_indicators?.volume?.interpretation?.includes('low'))
			volumeScore = 0.40;

		scores.volume = volumeScore;

		// Pattern (0-1)
		let patternScore = 0.5;
		if (shortTF.micro_patterns && shortTF.micro_patterns.length > 0)
			patternScore = shortTF.micro_patterns[0].confidence || 0.70;

		scores.pattern = patternScore;

		// Risk/Reward (0-1)
		let rrScore = 0.5;
		const primaryStrategy = scenarios.bullish_scenario || scenarios.bearish_scenario;
		if (primaryStrategy && primaryStrategy.targets && primaryStrategy.stop_loss && currentPrice) {
			const target = primaryStrategy.targets[0]?.price || 0;
			const stop = primaryStrategy.stop_loss?.price || 0;
			const entry = currentPrice; // Use actual current price, not approximation
			const risk = Math.abs(entry - stop);
			const reward = Math.abs(target - entry);
			const rr = risk > 0 ? reward / risk : 0;

			if (rr > 2.5) rrScore = 0.95;
			else if (rr > 2.0) rrScore = 0.85;
			else if (rr > 1.5) rrScore = 0.70;
			else rrScore = 0.50;
		}
		scores.risk_reward = rrScore;

		// Overall
		scores.overall = round(
			(scores.trend_alignment * 0.3 +
			 scores.momentum * 0.2 +
			 scores.volume * 0.15 +
			 scores.pattern * 0.2 +
			 scores.risk_reward * 0.15),
			2
		);

		return {
			overall: scores.overall,
			components: {
				trend_alignment: round(scores.trend_alignment, 2),
				momentum: round(scores.momentum, 2),
				volume: round(scores.volume, 2),
				pattern: round(scores.pattern, 2),
				risk_reward: round(scores.risk_reward, 2)
			}
		};
	}

	/**
	 * Generate recommendation
	 * Uses dynamic confidence calculation based on multiple factors
	 */
	_generateRecommendation(scenarios, tradeQuality, mtfAlignment) {
		const bullishProb = scenarios.bullish_scenario?.probability || 0;
		const bearishProb = scenarios.bearish_scenario?.probability || 0;
		const neutralProb = scenarios.neutral_scenario?.probability || 0;
		const overallQuality = tradeQuality.overall;
		const alignmentScore = mtfAlignment.alignment_score || 0;
		const hasConflicts = (mtfAlignment.conflicts?.length || 0) > 0;
		const dominantDirection = mtfAlignment.dominant_direction || 'neutral';

		// Calculate dynamic confidence based on multiple factors
		const directionStrength = Math.max(bullishProb, bearishProb) - neutralProb;
		const baseConfidence = (overallQuality * 0.4) + (alignmentScore * 0.3) + (directionStrength * 0.3);

		// Apply conflict penalty
		const conflictPenalty = hasConflicts ? 0.15 : 0;
		const confidence = round(Math.max(0.1, Math.min(0.95, baseConfidence - conflictPenalty)), 2);

		let action, reasoning;
		const isBullish = bullishProb > bearishProb;
		const direction = isBullish ? 'bullish' : 'bearish';
		const maxProb = Math.max(bullishProb, bearishProb);

		// TRADE: High quality + strong direction + good alignment
		if (overallQuality >= 0.70 && maxProb >= 0.50 && alignmentScore >= 0.70 && !hasConflicts) {
			action = isBullish ? 'TRADE_LONG' : 'TRADE_SHORT';
			reasoning = `Strong ${direction} setup: quality=${round(overallQuality, 2)}, alignment=${round(alignmentScore, 2)}, prob=${round(maxProb, 2)}`;
		}
		// PREPARE: Good quality, preparing for entry
		else if (overallQuality >= 0.60 && maxProb >= 0.45 && alignmentScore >= 0.60) {
			action = isBullish ? 'PREPARE_LONG' : 'PREPARE_SHORT';
			reasoning = `${direction} setup developing: wait for confirmation`;
		}
		// CAUTION: Mixed signals or moderate quality
		else if (overallQuality >= 0.50 && maxProb >= 0.40) {
			action = 'CAUTION';
			reasoning = hasConflicts ? 'MTF conflicts detected' : 'Moderate setup, increased risk';
		}
		// WAIT: Low quality or unclear direction
		else {
			action = 'WAIT';
			reasoning = neutralProb > 0.40 ? 'Neutral/ranging conditions' : 'Setup quality insufficient';
		}

		return { action, confidence, reasoning };
	}

	/**
	 * Sort timeframes from highest to lowest
	 * @private
	 */
	_sortTimeframes(timeframes) {
		const order = { '1m': 7, '1w': 6, '1d': 5, '4h': 4, '1h': 3, '30m': 2, '15m': 1, '5m': 0 };
		return [...timeframes].sort((a, b) => (order[b] || 0) - (order[a] || 0));
	}
}

export default TradingContextService;
