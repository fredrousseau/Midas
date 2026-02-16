/**
 * Market Context Service
 * Generates multi-timeframe market context for trading decisions
 * Orchestrates StatisticalContextService and RegimeDetectionService
 *
 * Output format:
 * - generateContext(): Full technical data for internal use/WebUI
 */

import StatisticalContextService from './StatisticalContextService.js';
import { RegimeDetectionService } from './RegimeDetectionService.js';

export class MarketContextService {
	constructor(parameters = {}) {
		this.logger = parameters.logger;
		if (!this.logger) throw new Error('MarketContextService requires a logger instance in options');

		this.dataProvider = parameters.dataProvider;
		if (!this.dataProvider) throw new Error('MarketContextService requires a dataProvider instance in options');

		this.indicatorService = parameters.indicatorService;
		if (!this.indicatorService) throw new Error('MarketContextService requires an indicatorService instance in options');

		// Initialize sub-services
		this.regimeDetectionService = new RegimeDetectionService(parameters);
		this.statisticalContextService = new StatisticalContextService({
			...parameters,
			regimeDetectionService: this.regimeDetectionService
		});

		this.logger.info('MarketContextService initialized.');
	}

	/**
	 * Generate full market context for a symbol across multiple timeframes
	 * Uses adaptive bar counts based on timeframe for optimal performance
	 * @param {Object} params - { symbol, timeframes, referenceDate }
	 * @returns {Promise<Object>} - Complete context with alignment and conflicts
	 */
	async generateContext({ symbol, timeframes, referenceDate, timeout }) {
		const timeoutMs = timeout || parseInt(process.env.CONTEXT_TIMEOUT_MS, 10) || 60000;

		// Generate statistical context with global timeout to prevent indefinite blocking
		const timeoutPromise = new Promise((_, reject) =>
			setTimeout(() => reject(new Error(`generateContext timed out after ${timeoutMs}ms for ${symbol}`)), timeoutMs)
		);

		const statContext = await Promise.race([
			this.statisticalContextService.generateFullContext({
				symbol,
				timeframes,
				referenceDate,
			}),
			timeoutPromise,
		]);

		const alignment = statContext._internal_alignment;

		// Assess overall quality
		const quality = this._assessAlignmentQuality(alignment);

		// Remove internal alignment from statContext before returning
		const { _internal_alignment, ...cleanStatContext } = statContext;

		return {
			symbol,
			timestamp: new Date().toISOString(),
			referenceDate: referenceDate || null,
			statistical_context: cleanStatContext,
			multi_timeframe_alignment: {
				...alignment,
				quality,
			},
		};
	}

	/**
	 * Assess overall alignment quality
	 * @private
	 */
	_assessAlignmentQuality(alignment) {
		const { alignment_score, conflicts } = alignment;

		const hasHighConflicts = conflicts.some((c) => c.severity === 'high');
		const hasModerateConflicts = conflicts.some((c) => c.severity === 'moderate');

		if (hasHighConflicts) return 'poor';
		if (alignment_score >= 0.85) return 'excellent';
		if (alignment_score >= 0.75 && !hasModerateConflicts) return 'good';
		if (alignment_score >= 0.6) return 'fair';
		return 'poor';
	}

	/**
	 * Detect market regime for a single symbol and timeframe
	 * Proxy method for RegimeDetectionService
	 * @param {Object} params - { symbol, timeframe, count, referenceDate }
	 * @returns {Promise<Object>} - Regime detection result
	 */
	async detectRegime({ symbol, timeframe = '1h', count = 200, referenceDate }) {
		return await this.regimeDetectionService.detectRegime({ symbol, timeframe, count, referenceDate });
	}
}

export default MarketContextService;
