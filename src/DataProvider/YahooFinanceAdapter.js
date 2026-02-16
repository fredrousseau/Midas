import { GenericAdapter } from './GenericAdapter.js';
import YahooFinance from 'yahoo-finance2';

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
 *   1h → 60m  | 2h → (not supported, falls back to 1h)
 *   4h → (not supported, falls back to 1h)
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

	// Mapping from Midas timeframe format to Yahoo Finance interval strings
	static TIMEFRAME_MAP = {
		'1m':  '1m',
		'5m':  '5m',
		'15m': '15m',
		'30m': '30m',
		'1h':  '60m',
		'2h':  '60m',  // Yahoo doesn't support 2h — falls back to 1h
		'4h':  '60m',  // Yahoo doesn't support 4h — falls back to 1h
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

		const yahooInterval = YahooFinanceAdapter.TIMEFRAME_MAP[timeframe];

		// Warn when timeframe is approximated
		if ((timeframe === '2h' || timeframe === '4h') && !this._warned2h4h) {
			this.logger.warn(`YahooFinanceAdapter: timeframe '${timeframe}' is not supported by Yahoo Finance — using 60m instead`);
			this._warned2h4h = true;
		}

		// Calculate date range from count + to/from
		const endDate = to ? new Date(to) : new Date();
		const startDate = from ? new Date(from) : this._calcStartDate(endDate, timeframe, count);

		this.logger.info(`Fetching ${count} bars for ${symbol} (${timeframe} → ${yahooInterval}) from ${startDate.toISOString()} to ${endDate.toISOString()}`);

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
			const ohlcv = result.quotes
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

			// Take only the last `count` bars to match expected behavior
			const trimmed = ohlcv.slice(-count);

			this._validateOHLCV(trimmed);

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
		// Indices are always static (Yahoo Finance has no index-member API)
		const indices = [
			{ symbol: '^FCHI',     name: 'CAC 40',       exchange: 'INDEX', type: 'INDEX', quoteAsset: 'EUR', status: 'TRADING' },
			{ symbol: '^STOXX50E', name: 'Euro Stoxx 50', exchange: 'INDEX', type: 'INDEX', quoteAsset: 'EUR', status: 'TRADING' },
			{ symbol: '^GSPC',     name: 'S&P 500',       exchange: 'INDEX', type: 'INDEX', quoteAsset: 'USD', status: 'TRADING' },
			{ symbol: '^IXIC',     name: 'Nasdaq',        exchange: 'INDEX', type: 'INDEX', quoteAsset: 'USD', status: 'TRADING' },
			{ symbol: '^DJI',      name: 'Dow Jones',     exchange: 'INDEX', type: 'INDEX', quoteAsset: 'USD', status: 'TRADING' },
		];

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

		return [...equities, ...indices];
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

		const indices = [
			{ symbol: '^FCHI',     name: 'CAC 40',       exchange: 'INDEX', type: 'INDEX', quoteAsset: 'EUR', status: 'TRADING' },
			{ symbol: '^STOXX50E', name: 'Euro Stoxx 50', exchange: 'INDEX', type: 'INDEX', quoteAsset: 'EUR', status: 'TRADING' },
			{ symbol: '^GSPC',     name: 'S&P 500',       exchange: 'INDEX', type: 'INDEX', quoteAsset: 'USD', status: 'TRADING' },
			{ symbol: '^IXIC',     name: 'Nasdaq',        exchange: 'INDEX', type: 'INDEX', quoteAsset: 'USD', status: 'TRADING' },
			{ symbol: '^DJI',      name: 'Dow Jones',     exchange: 'INDEX', type: 'INDEX', quoteAsset: 'USD', status: 'TRADING' },
		];

		return [...equities, ...indices];
	}

	/**
	 * Calculate start date from end date, timeframe, and bar count.
	 * Adds a 50% buffer to account for market closure gaps (weekends, holidays).
	 *
	 * @private
	 * @param {Date} endDate - End of the period
	 * @param {string} timeframe - Midas timeframe string
	 * @param {number} count - Number of bars needed
	 * @returns {Date} Calculated start date
	 */
	_calcStartDate(endDate, timeframe, count) {
		const tfMs = this._timeframeToMs(timeframe);
		// Buffer factor: 1.7 accounts for weekends (~2/7 days) + holidays + partial candles
		const bufferFactor = 1.7;
		const rangeMs = tfMs * count * bufferFactor;
		return new Date(endDate.getTime() - rangeMs);
	}

	/**
	 * Convert Midas timeframe string to milliseconds
	 * @private
	 */
	_timeframeToMs(timeframe) {
		const map = {
			'1m':  60 * 1000,
			'5m':  5  * 60 * 1000,
			'15m': 15 * 60 * 1000,
			'30m': 30 * 60 * 1000,
			'1h':  60 * 60 * 1000,
			'2h':  2  * 60 * 60 * 1000,
			'4h':  4  * 60 * 60 * 1000,
			'1d':  24 * 60 * 60 * 1000,
			'1w':  7  * 24 * 60 * 60 * 1000,
			'1M':  30 * 24 * 60 * 60 * 1000,
		};
		return map[timeframe] || 60 * 60 * 1000;
	}
}

export default YahooFinanceAdapter;
