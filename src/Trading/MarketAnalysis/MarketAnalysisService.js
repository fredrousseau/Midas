import { RegimeDetectionService } from './RegimeDetection/RegimeDetectionService.js';
import { StatisticalContextService } from './StatisticalContext/StatisticalContextService.js';
import { TradingContextService } from './TradingContext/TradingContextService.js';

/**
 * Market analysis service that orchestrates statistical and trading analysis
 */
export class MarketAnalysisService {

	/**
	 * Create a MarketAnalysisService instance
	 * @param {Object} parameters - Configuration parameters
	 * @param {Object} parameters.logger - Logger instance
	 * @param {Object} parameters.dataProvider - Data provider instance
	 * @param {Object} parameters.indicatorService - Indicator service instance
	 * @throws {Error} If logger, dataProvider, or indicatorService is not provided
	 */
	constructor(parameters = {}) {
		this.logger = parameters.logger || null;

		if (!this.logger) throw new Error('MarketAnalysisService requires a logger instance in options');

		this.dataProvider = parameters.dataProvider || null;
		if (!this.dataProvider) throw new Error('MarketAnalysisService requires a dataProvider instance in options');

		this.indicatorService = parameters.indicatorService || null;
		if (!this.indicatorService) throw new Error('MarketAnalysisService requires an indicatorService instance in options');

		// Regime detection service - detects market regimes
		this.regimeDetectionService = new RegimeDetectionService({
			logger: this.logger,
			dataProvider: this.dataProvider,
			indicatorService: this.indicatorService
		});

		// Statistical analysis service - generates technical indicators and statistical context
		this.statisticalContext = new StatisticalContextService({
			logger: this.logger,
			dataProvider: this.dataProvider,
			regimeDetectionService: this.regimeDetectionService,
			indicatorService: this.indicatorService
		});

		// Trading context service - generates actionable trading decisions
		this.tradingContext = new TradingContextService({
			logger: this.logger
		});

		this.logger.info('MarketAnalysisService initialized.');
	}

	// ========== PROXY METHODS FOR SUB-SERVICES ==========

	/**
	 * Detect market regime for a symbol
	 * @param {Object} options - Detection options (includes analysisDate for backtesting)
	 * @returns {Promise<Object>} Market regime analysis
	 */
	async detectRegime(options) {
		return await this.regimeDetectionService.detectRegime(options);
	}

	/**
	 * Get indicator time series (proxy to IndicatorService)
	 * Used by StatisticalContextService enrichers
	 * @param {Object} options - Time series options (includes analysisDate for backtesting)
	 * @returns {Promise<Object>} Indicator time series
	 */
	async getIndicatorTimeSeries(options) {
		return await this.indicatorService.getIndicatorTimeSeries(options);
	}

	// ========== MARKET ANALYSIS METHODS ==========

	/**
	 * Generate complete market analysis with trading context
	 * Orchestrates StatisticalContextService and TradingContextService
	 * @param {Object} options - { symbol, timeframes, count, analysisDate }
	 * @returns {Promise<Object>} Complete analysis with statistical context and trading decisions
	 */
	async generateEnrichedContext(options) {
		const { symbol, timeframes = ['1h'], count = 200, analysisDate } = options;

		// Step 1: Generate statistical context (indicators, patterns, alignment)
		const statisticalContext = await this.statisticalContext.generateFullContext({
			symbol,
			timeframes,
			count,
			analysisDate
		});

		// Step 2: Generate trading context from statistical analysis
		const tradingContext = this.tradingContext.generate(statisticalContext);

		// Step 3: Consolidate results
		return {
			...statisticalContext,
			trading_context: tradingContext
		};
	}

	/**
	 * Generate statistical context only (no trading decisions)
	 * @param {Object} options - { symbol, timeframes, count, analysisDate }
	 * @returns {Promise<Object>} Statistical context without trading decisions
	 */
	async generateStatisticalContext(options) {
		const { symbol, timeframes = ['1h'], count = 200, analysisDate } = options;
		return await this.statisticalContext.generateFullContext({
			symbol,
			timeframes,
			count,
			analysisDate
		});
	}

	/**
	 * Generate trading context from existing statistical context
	 * @param {Object} statisticalContext - Statistical context from generateStatisticalContext
	 * @returns {Object} Trading decisions and recommendations
	 */
	generateTradingContext(statisticalContext) {
		return this.tradingContext.generate(statisticalContext);
	}

	async quickMultiTimeframeCheck(options) {
		const { symbol, timeframes = ['1d', '4h', '1h'] } = options;

		const regimePromises = timeframes.map(async (tf) => {
			try {
				const regime = await this.detectRegime({ symbol, timeframe: tf, count: 100 });
				return { timeframe: tf, regime: regime.regime, confidence: regime.confidence };
			} catch (error) {
				return { timeframe: tf, error: error.message };
			}
		});

		const results = await Promise.all(regimePromises);
		const regimes = {};
		for (const result of results) regimes[result.timeframe] = result.error ? { error: result.error } : { regime: result.regime, confidence: result.confidence };

		const regimeValues = results.filter((r) => r.regime).map((r) => r.regime);

		const bullishCount = regimeValues.filter((r) => r.includes('bullish')).length;
		const bearishCount = regimeValues.filter((r) => r.includes('bearish')).length;
		const rangingCount = regimeValues.filter((r) => r.startsWith('range_')).length;
		const neutralCount = regimeValues.filter((r) => r.includes('neutral')).length;
		const totalRegimes = regimeValues.length;

		// Calculate alignment: if all trending/breakout regimes agree on direction, score is high
		// If most are ranging/neutral, alignment is moderate based on consistency
		let alignmentScore = 0;
		if (totalRegimes > 0) {
			const trendingCount = bullishCount + bearishCount;

			if (trendingCount > 0)
				// If we have trending regimes, score based on directional agreement
				alignmentScore = Math.max(bullishCount, bearishCount) / totalRegimes;
			// If all regimes are ranging/neutral, score based on consistency
			else alignmentScore = Math.max(rangingCount, neutralCount) / totalRegimes;
		}

		let quality = 'poor';
		if (alignmentScore >= 0.8) quality = 'perfect';
		else if (alignmentScore >= 0.6) quality = 'good';
		else if (alignmentScore >= 0.4) quality = 'mixed';

		// Determine dominant direction
		let dominantDirection = 'neutral';
		if (bullishCount > bearishCount && bullishCount > rangingCount) 
			dominantDirection = 'bullish';
		 else if (bearishCount > bullishCount && bearishCount > rangingCount) 
			dominantDirection = 'bearish';
		 else if (rangingCount > 0) 
			dominantDirection = 'ranging';

		return {
			symbol,
			timeframes,
			regimes,
			alignment: {
				score: Math.round(alignmentScore * 100) / 100,
				quality,
				dominant_direction: dominantDirection,
				conflicts: bullishCount > 0 && bearishCount > 0,
				distribution: {
					bullish: bullishCount,
					bearish: bearishCount,
					ranging: rangingCount,
					neutral: neutralCount,
				},
			},
			timestamp: new Date().toISOString(),
		};
	}

	// Unified statistical context service (combines V1 and V2 features)
	/*
		this.statisticalContext = new StatisticalContextService({
			logger: this.logger,
			dataProvider: this.dataProvider,
			tradingService: this,
			indicatorService: this.indicatorService
		});
		*/
}
