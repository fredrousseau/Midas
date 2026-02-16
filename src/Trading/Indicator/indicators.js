import * as TS from 'trading-signals';
import { IchimokuCloud } from './ichimoku.js';
import { CustomPSAR } from './CustomPSAR.js';
import { getIndicatorMetadata } from './registry.js';

const DEFAULT_TIMEFRAME = '1h';

// Indicator factory map
const INDICATOR_FACTORIES = {
	// Moving Averages
	sma: (config) => new TS.SMA(config.period),
	ema: (config) => new TS.EMA(config.period),
	wma: (config) => new TS.WMA(config.period),
	wsma: (config) => new TS.WSMA(config.period),
	dema: (config) => new TS.DEMA(config.period),
	rma: (config) => new TS.RMA(config.period),
	dma: (config) => new TS.DMA(config.short, config.long, TS.SMA),
	sma15: () => new TS.SMA15(),
	// Momentum
	rsi: (config) => new TS.RSI(config.period, TS.RMA),
	macd: (config) => new TS.MACD(new TS.EMA(config.fast), new TS.EMA(config.slow), new TS.EMA(config.signal)),
	stochastic: (config) => new TS.StochasticOscillator(config.k, config.d, config.d),
	stochRsi: (config) => {
		// StochasticRSI needs k and d for smoothing
		const k = config.k || 3;
		const d = config.d || 3;
		const smoothing = {
			k: new TS.SMA(k),
			d: new TS.SMA(d)
		};
		// Use SMA for the RSI calculation itself
		return new TS.StochasticRSI(config.period, TS.SMA, smoothing);
	},
	williamsR: (config) => new TS.WilliamsR(config.period),
	cci: (config) => new TS.CCI(config.period),
	roc: (config) => new TS.ROC(config.period),
	mom: (config) => new TS.MOM(config.period),
	// Volatility
	atr: (config) => new TS.ATR(config.period),
	bb: (config) => new TS.BollingerBands(config.period, config.deviation),
	accelerationBands: (config) => new TS.AccelerationBands(config.period, config.deviation),
	bbWidth: (config) => new TS.BollingerBandsWidth(new TS.BollingerBands(config.period, config.deviation)),
	iqr: (config) => new TS.IQR(config.period),
	mad: (config) => new TS.MAD(config.period),
	// Trend
	adx: (config) => new TS.ADX(config.period),
	dx: (config) => new TS.DX(config.period),
	psar: (config) => new CustomPSAR(config.step, config.max),
	tds: () => new TS.TDS(),
	ichimoku: (config) => new IchimokuCloud(config),
	// Volume
	obv: () => new TS.OBV(),
	vwap: () => new TS.VWAP(),
	// Support & Resistance
	linearRegression: (config) => new TS.LinearRegression(config.period),
	zigzag: (config) => new TS.ZigZag(config.threshold),
	// Advanced
	ao: (config) => new TS.AO(config.short, config.long),
	ac: (config) => new TS.AC(config.short, config.long, config.signal),
	cg: (config) => new TS.CG(config.period, config.signalInterval),
	rei: (config) => new TS.REI(config.period),
	tr: () => new TS.TR(),
};

// Input type mapping for indicators
const INPUT_TYPE_MAP = {
	obv: 'barWithVolume',
	sma: 'close',
	ema: 'close',
	wma: 'close',
	wsma: 'close',
	dema: 'close',
	rma: 'close',
	dma: 'close',
	sma15: 'close',
	rsi: 'close',
	macd: 'close',
	stochRsi: 'close',
	roc: 'close',
	mom: 'close',
	bb: 'close',
	bbWidth: 'close',
	accelerationBands: 'ohlc',
	iqr: 'close',
	mad: 'close',
	cg: 'close',
	rei: 'close',
	linearRegression: 'close',
	zigzag: 'close',
	tds: 'close',
	psar: 'highLow',
	atr: 'ohlc',
	adx: 'ohlc',
	dx: 'ohlc',
	tr: 'ohlc',
	williamsR: 'ohlc',
	stochastic: 'ohlc',
	ichimoku: 'highLowClose',
};

// Series output mapping
const SERIES_MAP = {
	macd: ['macd', 'macdSignal', 'macdHistogram'],
	bb: ['bbUpper', 'bbMiddle', 'bbLower'],
	accelerationBands: ['accelBandUpper', 'accelBandMiddle', 'accelBandLower'],
	stochastic: ['stochasticK', 'stochasticD'],
	stochRsi: ['stochRsi', 'stochRsiSignal'],
	dma: ['dmaShort', 'dmaLong'],
	adx: ['adx', 'plusDI', 'minusDI'],
	ichimoku: ['ichimokuTenkan', 'ichimokuKijun', 'ichimokuSenkouA', 'ichimokuSenkouB', 'ichimokuChikou'],
};

// Result mappers for multi-value indicators
const RESULT_MAPPERS = {
	macd: (r) => ({ macd: r?.macd?.valueOf(), macdSignal: r?.signal?.valueOf(), macdHistogram: r?.histogram?.valueOf() }),
	bb: (r) => ({ bbUpper: r?.upper?.valueOf(), bbMiddle: r?.middle?.valueOf(), bbLower: r?.lower?.valueOf() }),
	accelerationBands: (r) => ({ accelBandUpper: r?.upper?.valueOf(), accelBandMiddle: r?.middle?.valueOf(), accelBandLower: r?.lower?.valueOf() }),
	stochastic: (r) => ({ stochasticK: r?.stochK?.valueOf(), stochasticD: r?.stochD?.valueOf() }),
	stochRsi: (r) => ({ stochRsi: r?.smoothing?.k?.getResult?.(), stochRsiSignal: r?.smoothing?.d?.getResult?.() }),
	dma: (r) => ({ dmaShort: r?.short?.valueOf(), dmaLong: r?.long?.valueOf() }),
	adx: (instance) => ({ adx: instance?.getResult?.() || 0, plusDI: instance?.dx?.pdi || 0, minusDI: instance?.dx?.mdi || 0 }),
	ichimoku: (r) => ({
		ichimokuTenkan: r?.tenkan?.valueOf(),
		ichimokuKijun: r?.kijun?.valueOf(),
		ichimokuSenkouA: r?.senkouA?.valueOf(),
		ichimokuSenkouB: r?.senkouB?.valueOf(),
		ichimokuChikou: r?.chikou?.valueOf(),
	}),
};

const round = (value, decimals) => {
	if (value === null || value === undefined) return value;
	const factor = Math.pow(10, decimals);
	return Math.round(value * factor) / factor;
};

export class Indicator {
	constructor(options = {}) {
		this.dataProvider = options.dataProvider;
		this.logger = options.logger || console;
		this.indicatorPrecision = parseInt(process.env.INDICATOR_PRECISION || '3', 10);

		if (!this.dataProvider || typeof this.dataProvider.loadOHLCV !== 'function') throw new Error('Invalid dataProvider: must implement loadOHLCV()');

		this.logger.info(`Indicator initialized - Indicator precision: ${this.indicatorPrecision} decimal places`);
	}

	async calculateIndicators({ symbol, indicators, bars = 200, calculationBars, timeframe, referenceDate }) {
		// Calculate warmup needed for indicators
		const maxWarmup = this._calculateMaxWarmup(indicators);

		// Add safety buffer (20%) to warmup to ensure enough data
		const warmupBuffer = Math.ceil(maxWarmup * 1.2);

		// Total bars to fetch = requested bars + warmup
		const requestedBars = calculationBars || bars;
		const totalBarsToFetch = requestedBars + warmupBuffer;

		// Fetch OHLCV data (will load from cache if available with enough bars)
		this.logger.verbose(`Fetching OHLCV for ${symbol}: ${requestedBars} requested + ${warmupBuffer} warmup = ${totalBarsToFetch} total bars${referenceDate ? ` until ${referenceDate}` : ''}`);
		const ohlcvResult = await this.dataProvider.loadOHLCV({
			symbol,
			timeframe: timeframe || DEFAULT_TIMEFRAME,
			count: totalBarsToFetch,
			referenceDate,
			useCache: true,
			detectGaps: false,
		});
		const ohlcvBars = ohlcvResult.bars;

		if (!ohlcvBars || ohlcvBars.length === 0) throw new Error(`No data received for ${symbol}`);

		// Log if we didn't get enough bars
		if (ohlcvBars.length < totalBarsToFetch) 
			this.logger.warn(`Requested ${totalBarsToFetch} bars for ${symbol}/${timeframe} but only got ${ohlcvBars.length}. Results may have null values at the beginning.`);

		return this._calculateFromBars({ bars: ohlcvBars, indicators, requestedBars });
	}

	_calculateFromBars({ bars, indicators, requestedBars }) {
		const { instances, metadataCache } = this._initializeIndicators(indicators);
		const series = { timestamp: [], close: [] };

		// Calculate indicators on ALL bars (including warmup)
		for (const bar of bars) {
			series.timestamp.push(bar.timestamp);
			series.close.push(bar.close);

			for (const [indicatorKey, instance] of Object.entries(instances)) this._updateIndicator(instance, bar, metadataCache[indicatorKey], series);
		}

		// If requestedBars is specified, trim the series to only return the requested number of bars
		// This removes the warmup period from the results
		if (requestedBars && requestedBars < bars.length) {
			const trimOffset = bars.length - requestedBars;
			for (const key of Object.keys(series)) 
				if (Array.isArray(series[key])) 
					series[key] = series[key].slice(trimOffset);
			
		}

		const snapshot = this._getSnapshot(series);

		return {
			series,
			snapshot,
			metadata: {
				dataPoints: series.timestamp.length,
				totalBarsProcessed: bars.length,
				timestamp: Date.now(),
				indicators: Object.keys(indicators).length,
				symbol: bars[0]?.symbol || 'unknown',
			},
		};
	}

	_initializeIndicators(indicators) {
		const instances = {};
		const metadataCache = {};
		for (const [indicatorKey, userConfig] of Object.entries(indicators)) {
			const metadata = getIndicatorMetadata(indicatorKey);
			if (!metadata) {
				this.logger.warn(`Unknown indicator: ${indicatorKey}, skipping`);
				continue;
			}
			const factory = INDICATOR_FACTORIES[indicatorKey];
			if (!factory) throw new Error(`Unsupported indicator: ${indicatorKey}`);
			instances[indicatorKey] = factory(this._mergeConfig(metadata, userConfig));
			metadataCache[indicatorKey] = metadata;
		}
		return { instances, metadataCache };
	}

	_updateIndicator(instance, bar, metadata, series) {
		const indicatorKey = metadata.indicator;
		try {
			const inputType = INPUT_TYPE_MAP[indicatorKey];
			let input;

			if (inputType === 'barWithVolume') 
				input = { close: bar.close, volume: bar.volume };
			 else if (inputType === 'close') 
				input = bar.close;
			 else if (inputType === 'highLow') 
				input = { high: bar.high, low: bar.low };
			 else if (inputType === 'highLowClose') 
				input = { high: bar.high, low: bar.low, close: bar.close };
			 else if (inputType === 'ohlc') 
				input = { open: bar.open, high: bar.high, low: bar.low, close: bar.close };
			 else 
				input = bar;

			instance.update(input);
			const result = instance.getResult();
			// For StochRSI and ADX, pass the instance itself to access additional values
			const needsInstance = indicatorKey === 'stochRsi' || indicatorKey === 'adx';
			this._mapResultToSeries(indicatorKey, needsInstance ? instance : result, series);
		} catch {
			for (const seriesKey of this._getSeriesKeys(indicatorKey)) this._addToSeries(series, seriesKey, null);
		}
	}

	_mapResultToSeries(indicatorKey, result, series) {
		const mapper = RESULT_MAPPERS[indicatorKey];
		if (mapper) {
			const values = mapper(result);
			for (const [seriesKey, value] of Object.entries(values)) this._addToSeries(series, seriesKey, value);
		} else {
			this._addToSeries(series, indicatorKey, result);
		}
	}

	_addToSeries(series, seriesKey, value) {
		if (!series[seriesKey]) series[seriesKey] = [];
		series[seriesKey].push(value !== undefined && value !== null ? Number(value) : null);
	}

	_calculateMaxWarmup(indicators) {
		let maxWarmup = 0;
		for (const [indicatorKey, userConfig] of Object.entries(indicators)) {
			const metadata = getIndicatorMetadata(indicatorKey);
			if (!metadata) continue;
			const config = this._mergeConfig(metadata, userConfig);
			const warmup = typeof metadata.warmup === 'function' ? metadata.warmup(config) : metadata.warmup || 50;
			maxWarmup = Math.max(maxWarmup, warmup);
		}
		return maxWarmup || 50;
	}

	_getSeriesKeys(indicatorKey) {
		return SERIES_MAP[indicatorKey] || [indicatorKey];
	}

	_mergeConfig(metadata, userConfig) {
		return { ...metadata.defaultConfig, ...userConfig };
	}

	_getSnapshot(series) {
		const snapshot = {};
		for (const [seriesKey, values] of Object.entries(series)) if (Array.isArray(values) && values.length > 0) snapshot[seriesKey] = values.at(-1);
		return snapshot;
	}

	_applyOffsetAndLimit(data, offset, limit) {
		let result = data;
		if (offset > 0) result = result.slice(0, -offset);
		if (limit > 0) result = result.slice(-limit);
		return result;
	}

	async getIndicatorTimeSeries({ symbol, indicator, config = {}, bars = 200, calculationBars, offset = 0, timeframe, referenceDate }) {
		const metadata = getIndicatorMetadata(indicator);
		if (!metadata) throw new Error(`Invalid indicator: ${indicator}. Use getAvailableIndicators() to see all indicators.`);

		// Validate that requested bars can satisfy the indicator's warmup needs
		const mergedConfig = this._mergeConfig(metadata, config);
		const warmup = typeof metadata.warmup === 'function' ? metadata.warmup(mergedConfig) : metadata.warmup || 50;
		if (bars < warmup)
			this.logger.warn(`${indicator}: requested ${bars} bars but warmup needs ${warmup}. Results will have fewer valid data points.`);

		// Calculate indicators with automatic warmup handling
		const result = await this.calculateIndicators({
			symbol,
			indicators: { [indicator]: config },
			bars,
			calculationBars,
			timeframe,
			referenceDate,
		});

		const seriesKeys = this._getSeriesKeys(indicator);
		const fullTimestamps = result.series.timestamp;
		const validIndices = [];

		const firstSeries = result.series[seriesKeys[0]];
		if (!firstSeries) throw new Error(`No data found for indicator: ${indicator}`);

		// Find all valid (non-null) data points
		for (let i = 0; i < firstSeries.length; i++)
			if (
				seriesKeys.every((seriesKey) => {
					const s = result.series[seriesKey];
					return s && s[i] !== null && s[i] !== undefined;
				})
			)
				validIndices.push(i);

		// Apply offset and limit to valid indices
		const finalIndices = this._applyOffsetAndLimit(validIndices, offset, bars);

		// Warn if no valid data points
		if (finalIndices.length === 0) 
			this.logger.warn(`No valid data points for ${indicator}. Total bars: ${firstSeries.length}, Valid indices: ${validIndices.length}. This may indicate insufficient data or warmup issues.`);

		// Construire un tableau d'objets avec timestamp et valeurs pour chaque point
		const data = [];
		for (const idx of finalIndices) {
			const timestamp = fullTimestamps[idx];
			const dataPoint = { timestamp };

			// Pour les indicateurs composites, créer un objet values avec tous les composants
			const isComposite = seriesKeys.length > 1;
			if (isComposite) {
				dataPoint.values = {};
				for (const seriesKey of seriesKeys) {
					const value = result.series[seriesKey][idx];
					const roundedValue = value !== null && value !== undefined ? round(value, this.indicatorPrecision) : null;
					dataPoint.values[seriesKey] = roundedValue;
				}
			} else {
				// Pour les indicateurs simples, mettre directement la valeur
				const value = result.series[seriesKeys[0]][idx];
				const roundedValue = value !== null && value !== undefined ? round(value, this.indicatorPrecision) : null;
				dataPoint.value = roundedValue;
			}

			data.push(dataPoint);
		}

		const finalConfig = this._mergeConfig(metadata, config);

		return {
			symbol,
			indicator,
			category: metadata.category || 'unknown',
			config: finalConfig,
			timeframe: timeframe || DEFAULT_TIMEFRAME,
			bars: data.length,
			components: seriesKeys.length > 1 ? seriesKeys : null,
			data,
		};
	}
}

export default Indicator;