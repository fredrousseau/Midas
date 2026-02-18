import { GenericAdapter } from './GenericAdapter.js';
import YahooFinance from 'yahoo-finance2';
import { timeframeToMs } from '#utils/timeframe.js';

/**
 * Yahoo Finance Adapter
 *
 * Provides OHLCV data for stocks, ETFs, indices (CAC40, Euronext, US equities, etc.)
 * via the yahoo-finance2 library. Implements the same interface as BinanceAdapter.
 *
 * Symbol format: Yahoo Finance tickers
 *   - Euronext/CAC40 : 'MC.PA', 'AIR.PA', 'SAN.PA', 'TTE.PA'
 *   - US stocks      : 'AAPL', 'MSFT', 'TSLA'
 *   - ETFs           : 'SPY', 'QQQ', 'LYXE.PA'
 *   - Indices        : '^FCHI' (CAC40), '^GSPC' (S&P500), '^IXIC' (Nasdaq)
 *   - Crypto (Yahoo) : 'BTC-USD', 'ETH-USD'
 *
 * Timeframe mapping (Midas → Yahoo Finance intervals):
 *   1m → 1m   | 5m → 5m   | 15m → 15m | 30m → 30m
 *   1h → 60m  | 2h → aggregated from 1h bars
 *   4h → aggregated from 1h bars
 *   1d → 1d   | 1w → 1wk  | 1M → 1mo
 *
 * Limitations vs Binance:
 *   - Intraday data (< 1d) only available for the last 60 days
 *   - 1m data only available for the last 7 days
 *   - Market hours gaps are normal (overnight, weekends) — DataProvider will detect them
 *   - Rate limits: ~2000 requests/hour (no authentication required)
 */
export class YahooFinanceAdapter extends GenericAdapter {

	static VALID_TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w', '1M'];
	static MAX_LIMIT = 2000;

	// Cache for dynamic pairs (avoids repeated API calls)
	static _pairsCache = { data: null, expiresAt: 0 };
	static PAIRS_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

	// Static indices (shared between dynamic fetch and static fallback)
	static INDICES = [
		{ symbol: '^FCHI',     name: 'CAC 40',        exchange: 'INDEX', type: 'INDEX', quoteAsset: 'EUR', status: 'TRADING' },
		{ symbol: '^STOXX50E', name: 'Euro Stoxx 50',  exchange: 'INDEX', type: 'INDEX', quoteAsset: 'EUR', status: 'TRADING' },
		{ symbol: '^GSPC',     name: 'S&P 500',        exchange: 'INDEX', type: 'INDEX', quoteAsset: 'USD', status: 'TRADING' },
		{ symbol: '^IXIC',     name: 'Nasdaq',         exchange: 'INDEX', type: 'INDEX', quoteAsset: 'USD', status: 'TRADING' },
		{ symbol: '^DJI',      name: 'Dow Jones',      exchange: 'INDEX', type: 'INDEX', quoteAsset: 'USD', status: 'TRADING' },
	];

	// Timeframes that Yahoo doesn't support natively — we aggregate from 1h data
	static AGGREGATED_TIMEFRAMES = {
		'2h': 2,  // aggregate 2 × 1h bars
		'4h': 4,  // aggregate 4 × 1h bars
	};

	// Mapping from Midas timeframe format to Yahoo Finance interval strings
	static TIMEFRAME_MAP = {
		'1m':  '1m',
		'5m':  '5m',
		'15m': '15m',
		'30m': '30m',
		'1h':  '60m',
		'2h':  '60m',  // fetched as 1h, then aggregated
		'4h':  '60m',  // fetched as 1h, then aggregated
		'1d':  '1d',
		'1w':  '1wk',
		'1M':  '1mo',
	};

	/**
	 * @param {Object} parameters
	 * @param {Object} [parameters.logger] - Logger instance
	 * @param {number} [parameters.timeout=15000] - Request timeout in ms
	 */
	constructor(parameters = {}) {
		super(parameters);
		this._yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
		this.logger.info('YahooFinanceAdapter initialized (yahoo-finance2 v3)');
	}

	/**
	 * Fetch OHLCV data from Yahoo Finance
	 *
	 * @param {Object} params
	 * @param {string} params.symbol - Yahoo Finance ticker (e.g., 'MC.PA', 'AAPL', '^FCHI')
	 * @param {string} [params.timeframe='1d'] - Timeframe string (Midas format)
	 * @param {number} [params.count=200] - Number of bars to fetch
	 * @param {number} [params.from] - Start time (Unix timestamp in ms)
	 * @param {number} [params.to] - End time (Unix timestamp in ms)
	 * @returns {Promise<Array>} Array of OHLCV objects
	 */
	async fetchOHLC({ symbol, timeframe = '1d', count = 200, from, to }) {
		this._validateSymbol(symbol);
		this._validateTimeframe(timeframe, YahooFinanceAdapter.VALID_TIMEFRAMES);
		this._validateLimit(count, YahooFinanceAdapter.MAX_LIMIT);

		const aggregationFactor = YahooFinanceAdapter.AGGREGATED_TIMEFRAMES[timeframe];
		const yahooInterval = YahooFinanceAdapter.TIMEFRAME_MAP[timeframe];

		// For aggregated timeframes (2h, 4h), we need more 1h bars
		const fetchCount = aggregationFactor ? count * aggregationFactor + aggregationFactor : count;

		// Calculate date range from count + to/from
		const endDate = to ? new Date(to) : new Date();
		// Use '1h' for start date calc when aggregating, so the buffer is correct for the actual fetch interval
		const calcTimeframe = aggregationFactor ? '1h' : timeframe;
		const startDate = from ? new Date(from) : this._calcStartDate(endDate, calcTimeframe, fetchCount);

		if (aggregationFactor)
			this.logger.info(`Yahoo: fetching ${fetchCount} × 1h bars for ${symbol} to aggregate into ${count} × ${timeframe} (${startDate.toISOString()} → ${endDate.toISOString()})`);
		else
			this.logger.info(`Yahoo: fetching ${count} bars for ${symbol} (${timeframe} → ${yahooInterval}) (${startDate.toISOString()} → ${endDate.toISOString()})`);

		try {
			const startTime = Date.now();

			const result = await this._yf.chart(symbol, {
				period1: startDate,
				period2: endDate,
				interval: yahooInterval,
			});

			const duration = Date.now() - startTime;

			if (!result?.quotes || result.quotes.length === 0)
				throw new Error(`No data returned by Yahoo Finance for ${symbol} (${yahooInterval})`);

			// Transform Yahoo Finance format to standard OHLCV format
			let ohlcv = result.quotes
				.filter(q => q.open !== null && q.high !== null && q.low !== null && q.close !== null && q.volume !== null)
				.map(q => ({
					timestamp: new Date(q.date).getTime(),
					open:      parseFloat(q.open),
					high:      parseFloat(q.high),
					low:       parseFloat(q.low),
					close:     parseFloat(q.close),
					volume:    parseFloat(q.volume ?? 0),
					symbol,
				}));

			if (ohlcv.length === 0)
				throw new Error(`All bars for ${symbol} had null values — symbol may be delisted or invalid`);

			// Aggregate 1h bars into 2h/4h if needed
			if (aggregationFactor) {
				ohlcv = this._aggregateBars(ohlcv, aggregationFactor, symbol);
				this.logger.info(`YahooFinanceAdapter: aggregated ${result.quotes.length} × 1h bars into ${ohlcv.length} × ${timeframe} bars for ${symbol} in ${duration}ms`);
			}

			// Take only the last `count` bars to match expected behavior
			const trimmed = ohlcv.slice(-count);

			this._validateOHLCV(trimmed);

			if (!aggregationFactor)
				this.logger.info(`YahooFinanceAdapter: fetched ${trimmed.length} bars for ${symbol} in ${duration}ms`);

			return trimmed;
		} catch (error) {
			this.logger.error(`YahooFinanceAdapter: error fetching ${symbol}: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Get current price for a symbol
	 *
	 * @param {string} symbol - Yahoo Finance ticker
	 * @returns {Promise<number>} Current price
	 */
	async getPrice(symbol) {
		this._validateSymbol(symbol);

		try {
			this.logger.info(`YahooFinanceAdapter: fetching current price for ${symbol}`);
			const quote = await this._yf.quote(symbol);
			const price = quote?.regularMarketPrice;

			if (price === undefined || price === null)
				throw new Error(`No price data available for ${symbol}`);

			this.logger.info(`YahooFinanceAdapter: current price for ${symbol}: ${price}`);
			return parseFloat(price);
		} catch (error) {
			this.logger.error(`YahooFinanceAdapter: error fetching price for ${symbol}: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Search for symbols by company name or ticker.
	 *
	 * @param {string} query - Search term (e.g., 'LVMH', 'Total', 'Apple')
	 * @returns {Promise<Array>} Array of matching symbol objects
	 */
	async search(query) {
		if (!query || typeof query !== 'string' || query.trim().length === 0)
			throw new Error('search() requires a non-empty query string');

		this.logger.info(`YahooFinanceAdapter: searching for '${query}'`);

		try {
			const results = await this._yf.search(query.trim());
			return (results?.quotes || [])
				.filter(q => q.symbol && q.quoteType !== 'OPTION')
				.map(q => ({
					symbol:     q.symbol,
					name:       q.shortname || q.longname || q.symbol,
					exchange:   q.exchDisp || q.exchange || '',
					type:       q.quoteType || 'EQUITY',
					baseAsset:  q.symbol,
					quoteAsset: q.currency || '',
					status:     'TRADING',
				}));
		} catch (error) {
			this.logger.error(`YahooFinanceAdapter: search error for '${query}': ${error.message}`);
			throw error;
		}
	}

	/**
	 * Get list of available pairs/symbols.
	 * Fetches dynamically from Yahoo Finance (trending + screener) with a 6h cache.
	 * Falls back to a curated static list if the dynamic fetch fails.
	 *
	 * @param {Object} [options={}]
	 * @param {string} [options.query] - Search query (e.g., 'LVMH', 'Total')
	 * @param {string} [options.market] - Market filter: 'FR' (Euronext), 'US', 'all'
	 * @param {boolean} [options.refresh] - Force cache refresh
	 * @returns {Promise<Array>} Array of symbol objects
	 */
	async getPairs(options = {}) {
		const { query, market = 'all', refresh = false } = options;

		// If a search query is provided, use Yahoo Finance search
		if (query)
			try {
				const results = await this._yf.search(query);
				return (results?.quotes || []).map(q => ({
					symbol:     q.symbol,
					name:       q.shortname || q.longname || q.symbol,
					exchange:   q.exchange || '',
					type:       q.quoteType || '',
					baseAsset:  q.symbol,
					quoteAsset: q.currency || 'EUR',
					status:     'TRADING',
				}));
			} catch (error) {
				this.logger.error(`YahooFinanceAdapter: search error: ${error.message}`);
				return [];
			}

		// Return from cache if still valid
		const cache = YahooFinanceAdapter._pairsCache;
		if (!refresh && cache.data && Date.now() < cache.expiresAt) {
			this.logger.info('YahooFinanceAdapter: getPairs served from cache');
			return this._filterByMarket(cache.data, market);
		}

		// Fetch dynamically, fall back to static list on error
		try {
			const all = await this._fetchDynamicPairs();
			YahooFinanceAdapter._pairsCache = { data: all, expiresAt: Date.now() + YahooFinanceAdapter.PAIRS_CACHE_TTL_MS };
			this.logger.info(`YahooFinanceAdapter: getPairs fetched ${all.length} symbols dynamically`);
			return this._filterByMarket(all, market);
		} catch (error) {
			this.logger.warn(`YahooFinanceAdapter: dynamic getPairs failed (${error.message}), using static fallback`);
			const all = this._staticPairs();
			return this._filterByMarket(all, market);
		}
	}

	/**
	 * Fetch pairs dynamically from Yahoo Finance trending + screener APIs.
	 * Combines results from FR and US regions and deduplicates by symbol.
	 *
	 * @private
	 * @returns {Promise<Array>}
	 */
	async _fetchDynamicPairs() {
		// Fetch trending symbols for FR and US in parallel
		const [frTrending, usTrending, screenerResults] = await Promise.allSettled([
			this._yf.trendingSymbols('FR'),
			this._yf.trendingSymbols('US'),
			this._yf.screener({ scrIds: 'most_actives', count: 50 }),
		]);

		const normalize = (raw, defaultQuote) => {
			const quotes = Array.isArray(raw) ? raw : (raw?.quotes || []);
			return quotes
				.filter(q => q.symbol && q.quoteType !== 'INDEX')
				.map(q => ({
					symbol:     q.symbol,
					name:       q.shortname || q.longname || q.displayName || q.symbol,
					exchange:   q.fullExchangeName || q.exchange || '',
					type:       q.quoteType || 'EQUITY',
					baseAsset:  q.symbol,
					quoteAsset: q.currency || defaultQuote,
					status:     'TRADING',
				}));
		};

		const frSymbols  = frTrending.status  === 'fulfilled' ? normalize(frTrending.value,  'EUR') : [];
		const usSymbols  = usTrending.status  === 'fulfilled' ? normalize(usTrending.value,  'USD') : [];
		const scrSymbols = screenerResults.status === 'fulfilled' ? normalize(screenerResults.value?.quotes || [], 'USD') : [];

		// Merge and deduplicate by symbol
		const seen = new Set();
		const equities = [...frSymbols, ...usSymbols, ...scrSymbols].filter(s => {
			if (seen.has(s.symbol)) return false;
			seen.add(s.symbol);
			return true;
		});

		if (equities.length === 0)
			throw new Error('No symbols returned from Yahoo Finance trending/screener APIs');

		return [...equities, ...YahooFinanceAdapter.INDICES];
	}

	/**
	 * Filter a pairs list by market.
	 * @private
	 */
	_filterByMarket(all, market) {
		if (market === 'FR') return all.filter(s => s.quoteAsset === 'EUR' && s.type !== 'INDEX');
		if (market === 'US') return all.filter(s => s.quoteAsset === 'USD' && s.type !== 'INDEX');
		return all;
	}

	/**
	 * Static fallback list of major CAC40 + indices.
	 * Used when dynamic fetch fails.
	 * @private
	 */
	_staticPairs() {
		const equities = [
			{ symbol: 'MC.PA',   name: 'LVMH',              exchange: 'Euronext', type: 'EQUITY', quoteAsset: 'EUR', status: 'TRADING' },
			{ symbol: 'TTE.PA',  name: 'TotalEnergies',      exchange: 'Euronext', type: 'EQUITY', quoteAsset: 'EUR', status: 'TRADING' },
			{ symbol: 'SAN.PA',  name: 'Sanofi',             exchange: 'Euronext', type: 'EQUITY', quoteAsset: 'EUR', status: 'TRADING' },
			{ symbol: 'AIR.PA',  name: 'Airbus',             exchange: 'Euronext', type: 'EQUITY', quoteAsset: 'EUR', status: 'TRADING' },
			{ symbol: 'OR.PA',   name: "L'Oréal",            exchange: 'Euronext', type: 'EQUITY', quoteAsset: 'EUR', status: 'TRADING' },
			{ symbol: 'BNP.PA',  name: 'BNP Paribas',        exchange: 'Euronext', type: 'EQUITY', quoteAsset: 'EUR', status: 'TRADING' },
			{ symbol: 'CS.PA',   name: 'AXA',                exchange: 'Euronext', type: 'EQUITY', quoteAsset: 'EUR', status: 'TRADING' },
			{ symbol: 'SU.PA',   name: 'Schneider Electric',  exchange: 'Euronext', type: 'EQUITY', quoteAsset: 'EUR', status: 'TRADING' },
			{ symbol: 'AI.PA',   name: 'Air Liquide',         exchange: 'Euronext', type: 'EQUITY', quoteAsset: 'EUR', status: 'TRADING' },
			{ symbol: 'BN.PA',   name: 'Danone',              exchange: 'Euronext', type: 'EQUITY', quoteAsset: 'EUR', status: 'TRADING' },
			{ symbol: 'KER.PA',  name: 'Kering',              exchange: 'Euronext', type: 'EQUITY', quoteAsset: 'EUR', status: 'TRADING' },
			{ symbol: 'RI.PA',   name: 'Pernod Ricard',       exchange: 'Euronext', type: 'EQUITY', quoteAsset: 'EUR', status: 'TRADING' },
			{ symbol: 'DSY.PA',  name: 'Dassault Systèmes',   exchange: 'Euronext', type: 'EQUITY', quoteAsset: 'EUR', status: 'TRADING' },
			{ symbol: 'CAP.PA',  name: 'Capgemini',           exchange: 'Euronext', type: 'EQUITY', quoteAsset: 'EUR', status: 'TRADING' },
			{ symbol: 'DG.PA',   name: 'Vinci',               exchange: 'Euronext', type: 'EQUITY', quoteAsset: 'EUR', status: 'TRADING' },
			{ symbol: 'HO.PA',   name: 'Thales',              exchange: 'Euronext', type: 'EQUITY', quoteAsset: 'EUR', status: 'TRADING' },
			{ symbol: 'VIE.PA',  name: 'Veolia',              exchange: 'Euronext', type: 'EQUITY', quoteAsset: 'EUR', status: 'TRADING' },
			{ symbol: 'ENGI.PA', name: 'Engie',               exchange: 'Euronext', type: 'EQUITY', quoteAsset: 'EUR', status: 'TRADING' },
			{ symbol: 'SGO.PA',  name: 'Saint-Gobain',        exchange: 'Euronext', type: 'EQUITY', quoteAsset: 'EUR', status: 'TRADING' },
			{ symbol: 'MT.AS',   name: 'ArcelorMittal',       exchange: 'Euronext', type: 'EQUITY', quoteAsset: 'EUR', status: 'TRADING' },
		];

		return [...equities, ...YahooFinanceAdapter.INDICES];
	}

	/**
	 * Aggregate 1h OHLCV bars into higher timeframe bars (2h, 4h).
	 *
	 * Groups consecutive 1h bars by the target timeframe boundary, then merges
	 * each group into a single OHLCV bar:
	 *   - timestamp: start of the period (first bar's timestamp)
	 *   - open: first bar's open
	 *   - high: max high across the group
	 *   - low: min low across the group
	 *   - close: last bar's close
	 *   - volume: sum of all volumes
	 *
	 * Incomplete groups (fewer bars than aggregationFactor) at the end are kept
	 * as-is so the most recent data is not lost.
	 *
	 * @private
	 * @param {Array} bars - Array of 1h OHLCV bars (sorted by timestamp asc)
	 * @param {number} factor - Number of 1h bars per aggregated bar (2 or 4)
	 * @param {string} symbol - Symbol (included in output bars)
	 * @returns {Array} Aggregated OHLCV bars
	 */
	_aggregateBars(bars, factor, symbol) {
		if (bars.length === 0) return [];

		const periodMs = factor * 3600000; // factor × 1 hour
		const aggregated = [];
		let group = [];
		let groupStart = null;

		for (const bar of bars) {
			// Determine which period this bar belongs to by flooring its timestamp
			const period = Math.floor(bar.timestamp / periodMs) * periodMs;

			if (groupStart !== null && period !== groupStart) {
				// Flush the current group
				aggregated.push(this._mergeGroup(group, symbol));
				group = [];
			}

			groupStart = period;
			group.push(bar);
		}

		// Flush the last group (may be incomplete — that's fine)
		if (group.length > 0)
			aggregated.push(this._mergeGroup(group, symbol));

		return aggregated;
	}

	/**
	 * Merge a group of OHLCV bars into a single bar.
	 * @private
	 * @param {Array} group - Array of OHLCV bars to merge
	 * @param {string} symbol - Symbol
	 * @returns {Object} Merged OHLCV bar
	 */
	_mergeGroup(group, symbol) {
		return {
			timestamp: group[0].timestamp,
			open:      group[0].open,
			high:      Math.max(...group.map(b => b.high)),
			low:       Math.min(...group.map(b => b.low)),
			close:     group[group.length - 1].close,
			volume:    group.reduce((sum, b) => sum + b.volume, 0),
			symbol,
		};
	}

	/**
	 * Calculate start date from end date, timeframe, and bar count.
	 *
	 * Unlike Binance which accepts a `count` parameter, Yahoo Finance only accepts
	 * a date range (period1 → period2). So we must convert the desired bar count
	 * into a calendar duration — but stock markets don't trade 24/7:
	 *
	 *   - Stocks trade ~8.5h/day (e.g. Euronext 9h-17h30), 5 days/week
	 *   - A naive "count × timeframeMs" assumes 24/7 trading (crypto-style)
	 *   - For 250 bars of 1h with naive calc: 250h ≈ 10.4 days → only ~88 trading bars
	 *
	 * Buffer factors compensate for non-trading hours:
	 *   - Intraday: 24/8.5 (nights) × 7/5 (weekends) × 1.05 (holidays) ≈ 4.2x
	 *   - Daily+: 7/5 (weekends) × 1.05 (holidays) ≈ 1.5x
	 *
	 * Example: 250 bars × 1h × 4.2 = 1050h ≈ 44 calendar days → ~250 trading bars
	 *
	 * Yahoo Finance intraday limits: 1m=7d, 5m-30m=60d, 1h=730d
	 *
	 * @private
	 * @param {Date} endDate - End of the period
	 * @param {string} timeframe - Midas timeframe string
	 * @param {number} count - Number of bars needed
	 * @returns {Date} Calculated start date
	 */
	_calcStartDate(endDate, timeframe, count) {
		const tfMs = timeframeToMs(timeframe, { throwOnError: false, defaultValue: 3600000 });

		const isIntraday = tfMs < 86400000; // < 1 day
		const bufferFactor = isIntraday ? 4.2 : 1.5;
		const rangeMs = tfMs * count * bufferFactor;
		return new Date(endDate.getTime() - rangeMs);
	}

}

export default YahooFinanceAdapter;
