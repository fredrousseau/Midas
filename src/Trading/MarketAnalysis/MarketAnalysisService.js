/**
 * Market Analysis Service (Unified)
 * Handles multi-timeframe market analysis and trading context generation
 * Orchestrates StatisticalContextService and generates actionable insights
 *
 * Output formats:
 * - generateMarketAnalysis(): Full technical data for internal use/WebUI
 * - generateForLLM(): Optimized format for LLM decision-making
 */

import StatisticalContextService from './StatisticalContextService.js';
import { RegimeDetectionService } from './RegimeDetectionService.js';

export class MarketAnalysisService {
	constructor(parameters = {}) {
		this.logger = parameters.logger;
		if (!this.logger) throw new Error('MarketAnalysisService requires a logger instance in options');

		this.dataProvider = parameters.dataProvider;
		if (!this.dataProvider) throw new Error('MarketAnalysisService requires a dataProvider instance in options');

		this.indicatorService = parameters.indicatorService;
		if (!this.indicatorService) throw new Error('MarketAnalysisService requires an indicatorService instance in options');

		// Initialize sub-services
		this.regimeDetectionService = new RegimeDetectionService(parameters);
		this.statisticalContextService = new StatisticalContextService({
			...parameters,
			regimeDetectionService: this.regimeDetectionService
		});

		this.logger.info('MarketAnalysisService initialized.');
	}

	/**
	 * Generate full market analysis for a symbol across multiple timeframes
	 * Uses adaptive bar counts based on timeframe for optimal performance
	 * @param {Object} params - { symbol, timeframes, analysisDate }
	 * @returns {Promise<Object>} - Complete analysis with alignment, conflicts, and recommendations
	 */
	async generateMarketAnalysis({ symbol, timeframes, analysisDate }) {
		// Generate statistical context with built-in alignment analysis
		// Uses adaptive count based on timeframe
		const statContext = await this.statisticalContextService.generateFullContext({
			symbol,
			timeframes,
			analysisDate,
		});

		const alignment = statContext._internal_alignment;

		// Generate recommendation based on alignment
		const recommendation = this._generateRecommendation(alignment);

		// Assess overall quality
		const quality = this._assessAlignmentQuality(alignment);

		// Remove internal alignment from statContext before returning
		const { _internal_alignment, ...cleanStatContext } = statContext;

		return {
			symbol,
			timestamp: new Date().toISOString(),
			analysisDate: analysisDate || null,
			statistical_context: cleanStatContext,
			multi_timeframe_alignment: {
				...alignment,
				quality,
				recommendation,
			},
		};
	}

	/**
	 * Generate trading recommendation based on alignment
	 * @private
	 */
	_generateRecommendation(alignment) {
		const { alignment_score, dominant_direction, conflicts } = alignment;

		// Check for high-severity conflicts
		const hasHighConflicts = conflicts.some((c) => c.severity === 'high');
		const hasModerateConflicts = conflicts.some((c) => c.severity === 'moderate');

		let action = 'WAIT';
		let confidence = 0.5;
		let reasoning = '';

		if (hasHighConflicts) {
			action = 'WAIT';
			confidence = 0.3;
			reasoning = 'Major timeframe conflicts detected - wait for alignment';
		} else if (alignment_score >= 0.8 && dominant_direction !== 'neutral') {
			action = `TRADE_${dominant_direction.toUpperCase()}`;
			confidence = alignment_score;
			reasoning = `Strong ${dominant_direction} alignment across timeframes`;
		} else if (alignment_score >= 0.7 && dominant_direction !== 'neutral' && !hasModerateConflicts) {
			action = `PREPARE_${dominant_direction.toUpperCase()}`;
			confidence = alignment_score * 0.9;
			reasoning = `Good ${dominant_direction} alignment - wait for entry confirmation`;
		} else if (alignment_score >= 0.6) {
			action = 'CAUTION';
			confidence = alignment_score * 0.8;
			reasoning = 'Moderate alignment - reduce position size or wait';
		} else {
			action = 'WAIT';
			confidence = 0.4;
			reasoning = 'Weak alignment or unclear direction';
		}

		return {
			action,
			confidence: Math.round(confidence * 100) / 100,
			reasoning,
			conflicts_summary: this._summarizeConflicts(conflicts),
		};
	}

	/**
	 * Summarize conflicts for recommendation
	 * @private
	 */
	_summarizeConflicts(conflicts) {
		if (conflicts.length === 0) return 'No conflicts detected';

		const bySeverity = {
			high: conflicts.filter((c) => c.severity === 'high').length,
			moderate: conflicts.filter((c) => c.severity === 'moderate').length,
			low: conflicts.filter((c) => c.severity === 'low').length,
		};

		const parts = [];
		if (bySeverity.high > 0) parts.push(`${bySeverity.high} high`);
		if (bySeverity.moderate > 0) parts.push(`${bySeverity.moderate} moderate`);
		if (bySeverity.low > 0) parts.push(`${bySeverity.low} low`);

		return parts.length > 0 ? `${parts.join(', ')} severity conflict(s)` : 'Minor conflicts';
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
	 * Generate LLM-optimized market analysis
	 * Returns a clean, interpreted format suitable for LLM decision-making
	 * Removes technical metadata, keeps only actionable information
	 * @param {Object} params - { symbol, timeframes, analysisDate }
	 * @returns {Promise<Object>} - LLM-ready analysis
	 */
	async generateForLLM({ symbol, timeframes, analysisDate }) {
		// Generate full context
		const statContext = await this.statisticalContextService.generateFullContext({
			symbol,
			timeframes,
			analysisDate,
		});

		const alignment = statContext._internal_alignment;

		// Transform to LLM format
		return this.statisticalContextService.transformForLLM(statContext, alignment);
	}

	/**
	 * Detect market regime for a single symbol and timeframe
	 * Proxy method for RegimeDetectionService
	 * @param {Object} params - { symbol, timeframe, count, analysisDate }
	 * @returns {Promise<Object>} - Regime detection result
	 */
	async detectRegime({ symbol, timeframe = '1h', count = 200, analysisDate }) {
		return await this.regimeDetectionService.detectRegime({ symbol, timeframe, count, analysisDate });
	}
}

export default MarketAnalysisService;
