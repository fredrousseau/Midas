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

		// Get timeframe data
		const h1 = timeframes['1h'] || {};
		const h4 = timeframes['4h'] || {};
		const d1 = timeframes['1d'] || {};

		// Extract current price from the lowest timeframe available
		const sortedTFs = this._sortTimeframes(Object.keys(timeframes));
		const currentPrice = timeframes[sortedTFs[sortedTFs.length - 1]]?.price_action?.current;

		if (!currentPrice)
			throw new Error(`Unable to extract current price from timeframe data`);

		const symbol = metadata.symbol;

		// Determine current market phase
		const marketPhase = this._determineMarketPhase(h1, h4, d1, mtfAlignment);

		// Generate scenarios
		const scenarios = this._generateScenarios(h1, h4, d1, currentPrice, mtfAlignment);

		// Generate entry strategies
		const entryStrategies = this._generateEntryStrategies(scenarios, h1, h4, currentPrice);

		// Assess risk factors
		const riskFactors = this._assessRiskFactors(h1, h4, d1, mtfAlignment);

		// Calculate trade quality score
		const tradeQuality = this._calculateTradeQuality(h1, h4, d1, mtfAlignment, scenarios, currentPrice);

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
	 */
	_determineMarketPhase(h1, h4, d1, mtfAlignment) {
		const h1Regime = h1.regime?.type || '';
		const h4Regime = h4.regime?.type || '';
		const d1Regime = d1.regime?.type || '';
		const dominantDirection = mtfAlignment.dominant_direction || 'neutral';

		// Trending phases
		if (h4Regime.includes('trending') && d1Regime.includes('trending')) {
			const direction = dominantDirection === 'bullish' ? 'uptrend' :
			                  dominantDirection === 'bearish' ? 'downtrend' : 'trend';

			if (h1Regime.includes('ranging'))
				return `consolidation within ${direction}`;

			return `strong ${direction}`;
		}

		// Ranging phases
		if (h1Regime.includes('ranging') && h4Regime.includes('ranging'))
			return 'consolidation';

		// Breakout phases
		if (h1Regime.includes('breakout') || h4Regime.includes('breakout')) {
			const breakoutDir = h1Regime.includes('bullish') || h4Regime.includes('bullish') ? 'bullish' :
			                    h1Regime.includes('bearish') || h4Regime.includes('bearish') ? 'bearish' : '';
			return breakoutDir ? `${breakoutDir} breakout phase` : 'breakout phase';
		}

		// Transition
		if ((h1Regime.includes('trending') && h4Regime.includes('ranging')) ||
		    (h1Regime.includes('ranging') && h4Regime.includes('trending')))
			return 'transition phase';

		return 'mixed conditions';
	}

	/**
	 * Generate trading scenarios
	 */
	_generateScenarios(h1, h4, d1, currentPrice, mtfAlignment) {
		// Generate scenarios with raw scores
		const bullish = this._generateBullishScenario(h1, h4, d1, currentPrice, mtfAlignment);
		const bearish = this._generateBearishScenario(h1, h4, d1, currentPrice, mtfAlignment);
		const neutral = this._generateNeutralScenario(h1, currentPrice, mtfAlignment);

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
	_generateBullishScenario(h1, h4, d1, currentPrice, mtfAlignment) {
		const isBullishAligned = mtfAlignment.dominant_direction === 'bullish';

		// Determine trigger
		let trigger = 'break above resistance';
		if (h1.price_action?.breakout_levels?.upside)
			trigger = `H1 break above ${h1.price_action.breakout_levels.upside} with volume`;

		// Calculate raw score (not probability yet - will be normalized)
		let rawScore = 40; // Base score
		if (isBullishAligned) rawScore += 20;
		if (mtfAlignment.alignment_score > 0.7) rawScore += 10;
		if (h4.regime?.type?.includes('trending_bullish')) rawScore += 10;
		if (h1.micro_patterns?.some(p => p.pattern === 'bull flag')) rawScore += 10;

		// Determine targets
		const targets = this._calculateBullishTargets(h1, h4, d1, currentPrice);

		// Rationale
		const rationale = this._buildBullishRationale(h1, h4, d1, mtfAlignment);

		// Stop loss
		const stopLoss = this._calculateBullishStop(h1, h4, currentPrice);

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
	_generateBearishScenario(h1, h4, d1, currentPrice, mtfAlignment) {
		const isBearishAligned = mtfAlignment.dominant_direction === 'bearish';

		let trigger = 'break below support';
		if (h1.price_action?.breakout_levels?.downside)
			trigger = `H1 break below ${h1.price_action.breakout_levels.downside} with volume`;

		// Calculate raw score (not probability yet - will be normalized)
		let rawScore = 30; // Base (usually lower if not in downtrend)
		if (isBearishAligned) rawScore += 20;
		if (mtfAlignment.alignment_score > 0.7 && isBearishAligned) rawScore += 10;
		if (h4.regime?.type?.includes('trending_bearish')) rawScore += 10;

		const targets = this._calculateBearishTargets(h1, h4, currentPrice);
		const rationale = this._buildBearishRationale(h1, h4, mtfAlignment);
		const stopLoss = this._calculateBearishStop(h1, h4, currentPrice);

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
	_generateNeutralScenario(h1, currentPrice, mtfAlignment) {
		const breakoutLevels = h1.price_action?.breakout_levels;

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
	_calculateBullishTargets(h1, h4, d1, currentPrice) {
		const targets = [];

		// Target 1: Near resistance from H4
		if (h4.support_resistance?.resistance_levels?.[0]) {
			const level = h4.support_resistance.resistance_levels[0].level;
			targets.push({
				price: level,
				basis: h4.support_resistance.resistance_levels[0].type,
				probability: 0.80
			});
		}

		// Target 2: Pattern projection or next major level
		if (h1.micro_patterns?.length > 0) {
			const pattern = h1.micro_patterns[0];
			if (pattern.target_if_breaks) 
				targets.push({
					price: pattern.target_if_breaks,
					basis: `${pattern.pattern} projection`,
					probability: 0.60
				});
			
		}

		// Target 3: Major resistance
		if (h4.support_resistance?.resistance_levels?.[1]) 
			targets.push({
				price: h4.support_resistance.resistance_levels[1].level,
				basis: 'major resistance',
				probability: 0.40
			});

		return targets.slice(0, 3);
	}

	/**
	 * Calculate bearish targets
	 */
	_calculateBearishTargets(h1, h4, currentPrice) {
		const targets = [];

		// Target 1: Near support from H4
		if (h4.support_resistance?.support_levels?.[0]) 
			targets.push({
				price: h4.support_resistance.support_levels[0].level,
				basis: h4.support_resistance.support_levels[0].type,
				probability: 0.70
			});

		// Target 2: Major support
		if (h4.support_resistance?.support_levels?.[1]) 
			targets.push({
				price: h4.support_resistance.support_levels[1].level,
				basis: 'major support',
				probability: 0.45
			});

		return targets;
	}

	/**
	 * Build bullish rationale
	 */
	_buildBullishRationale(h1, h4, d1, mtfAlignment) {
		const reasons = [];

		if (mtfAlignment.dominant_direction === 'bullish') 
			reasons.push('HTF trend bullish');
		
		if (h1.micro_patterns?.some(p => p.pattern.includes('bull'))) 
			reasons.push(h1.micro_patterns[0].pattern);
		
		if (h4.volatility_indicators?.bollinger_bands?.squeeze_detected) 
			reasons.push('BB squeeze');
		
		if (h4.volume_indicators?.obv?.interpretation?.includes('supporting')) 
			reasons.push('volume confirmation');

		return reasons.join(' + ');
	}

	/**
	 * Build bearish rationale
	 */
	_buildBearishRationale(h1, h4, mtfAlignment) {
		const reasons = [];

		if (mtfAlignment.dominant_direction === 'bearish') 
			reasons.push('HTF trend bearish');
		
		if (h1.price_action?.bar_type?.includes('bearish')) 
			reasons.push('bearish price action');

		return reasons.length > 0 ? reasons.join(' + ') : 'counter-trend setup';
	}

	/**
	 * Calculate bullish stop
	 */
	_calculateBullishStop(h1, h4, currentPrice) {
		// Use recent support or pattern invalidation
		let stopPrice = currentPrice * 0.97; // Default 3% stop

		if (h1.micro_patterns?.length > 0 && h1.micro_patterns[0].invalidation) 
			stopPrice = h1.micro_patterns[0].invalidation;
		 else if (h4.moving_averages?.ema?.ema26) 
			stopPrice = h4.moving_averages.ema.ema26;

		return {
			price: round(stopPrice, 0),
			basis: 'below key support'
		};
	}

	/**
	 * Calculate bearish stop
	 */
	_calculateBearishStop(h1, h4, currentPrice) {
		let stopPrice = currentPrice * 1.03; // Default 3% stop

		if (h4.moving_averages?.ema?.ema26) 
			stopPrice = h4.moving_averages.ema.ema26;

		return {
			price: round(stopPrice, 0),
			basis: 'above resistance'
		};
	}

	/**
	 * Generate entry strategies
	 */
	_generateEntryStrategies(scenarios, h1, h4, currentPrice) {
		const strategies = {};

		// Primary strategy (highest probability scenario)
		const bullishProb = scenarios.bullish_scenario?.probability || 0;
		const bearishProb = scenarios.bearish_scenario?.probability || 0;

		if (bullishProb > bearishProb) 
			strategies.primary = this._buildBreakoutStrategy('bullish', scenarios.bullish_scenario, currentPrice);
		 else 
			strategies.primary = this._buildBreakoutStrategy('bearish', scenarios.bearish_scenario, currentPrice);

		// Alternative strategy
		strategies.alternative = this._buildRetestStrategy(h1, h4, currentPrice);

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
	_buildRetestStrategy(h1, h4, currentPrice) {
		const supportLevels = h4.support_resistance?.support_levels || [];
		
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
	_assessRiskFactors(h1, h4, d1, mtfAlignment) {
		const risks = [];

		// MTF conflicts
		if (mtfAlignment.conflicts && mtfAlignment.conflicts.length > 0) 
			risks.push({
				factor: 'MTF conflicts',
				impact: mtfAlignment.conflicts[0].severity || 'medium',
				mitigation: 'Wait for alignment or reduce position size'
			});

		// Consolidation duration
		if (h1.regime?.type?.includes('ranging')) 
			risks.push({
				factor: 'H1 consolidation',
				impact: 'low',
				mitigation: 'Pattern typically resolves quickly'
			});

		// Divergences
		if (h1.momentum_indicators?.rsi?.divergence?.includes('divergence')) 
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
	_calculateTradeQuality(h1, h4, d1, mtfAlignment, scenarios, currentPrice) {
		const scores = {};

		// Trend alignment (0-1)
		scores.trend_alignment = mtfAlignment.alignment_score || 0.5;

		// Momentum (0-1)
		let momentumScore = 0.5;
		if (h4.momentum_indicators?.rsi?.value) {
			const rsi = h4.momentum_indicators.rsi.value;
			if (rsi > 50 && rsi < 70) momentumScore = 0.80;
			else if (rsi > 40 && rsi < 80) momentumScore = 0.65;
			else momentumScore = 0.40;
		}
		scores.momentum = momentumScore;

		// Volume (0-1)
		let volumeScore = 0.5;
		if (h4.volume_indicators?.volume?.interpretation?.includes('good')) 
			volumeScore = 0.75;
		 else if (h4.volume_indicators?.volume?.interpretation?.includes('low')) 
			volumeScore = 0.40;
		
		scores.volume = volumeScore;

		// Pattern (0-1)
		let patternScore = 0.5;
		if (h1.micro_patterns && h1.micro_patterns.length > 0) 
			patternScore = h1.micro_patterns[0].confidence || 0.70;
		
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
	 */
	_generateRecommendation(scenarios, tradeQuality, mtfAlignment) {
		const bullishProb = scenarios.bullish_scenario?.probability || 0;
		const bearishProb = scenarios.bearish_scenario?.probability || 0;
		const overallQuality = tradeQuality.overall;

		let action, confidence, reasoning;

		// High quality setup
		if (overallQuality > 0.75 && (bullishProb > 0.65 || bearishProb > 0.65)) {
			const direction = bullishProb > bearishProb ? 'bullish' : 'bearish';
			action = `WAIT for ${direction === 'bullish' ? 'upside' : 'downside'} breakout, then ${direction === 'bullish' ? 'BUY' : 'SELL'}`;
			confidence = round(Math.max(bullishProb, bearishProb), 2);
			reasoning = `High quality setup: ${scenarios.bullish_scenario?.rationale || scenarios.bearish_scenario?.rationale}`;
		}
		// Medium quality
		else if (overallQuality > 0.60 && (bullishProb > 0.55 || bearishProb > 0.55)) {
			action = 'WAIT for confirmation';
			confidence = 0.65;
			reasoning = 'Decent setup but needs confirmation';
		}
		// Low quality or conflicting
		else {
			action = 'WAIT';
			confidence = 0.40;
			reasoning = mtfAlignment.conflicts?.length > 0
				? 'MTF conflicts detected, unclear direction'
				: 'Setup quality insufficient';
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
