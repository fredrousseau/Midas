/**
 * MCP & API Routes
 */

import { asyncHandler, parseTradingParams } from './Utils/helpers.js';
import rateLimit from 'express-rate-limit';

// Helper to create rate limiters with consistent logging
function makeLimiter({ logger: logger, windowMs = 15 * 60 * 1000, max = 100 } = {}) {
	return rateLimit({
		windowMs,
		max,
		standardHeaders: true,
		legacyHeaders: false,
		handler: (req, res) => {
			logger.info(`Rate limit exceeded for IP: ${req.ip} on ${req.path}`);
			res.status(429).json({ error: 'too_many_requests' });
		},
	});
}

// Auth Middleware Factory - Returns a middleware that verifies JWT Token
function createAuthMiddleware(oauthService) {
	return function authMiddleware(req, res, next) {
		const { authorization: authHeader } = req.headers;
		if (!authHeader || !authHeader.startsWith('Bearer ')) 
			return res.status(401).json({ error: 'Missing or invalid authorization header' });

		const token = authHeader.slice(7).trim();
		if (!token) return res.status(401).json({ error: 'Token cannot be empty' });

		const validation = oauthService.validateToken(token);
		if (!validation.valid) 
			return res.status(401).json({ error: 'Invalid or expired token' });

		req.user = { id: validation.payload.sub, scope: validation.payload.scope };
		next();
	};
}

/**
 * Register all routes
 * @param {Express} app - Express application
 * @param {Object} logger - Logger instance
 
 */

export function registerRoutes(parameters) {
	const app = parameters.app || null;
	if (!app) throw new Error('registerTradingRoutes requires an app instance in options');

	const dataProvider = parameters.dataProvider || null;
	if (!dataProvider) throw new Error('registerTradingRoutes requires a dataProvider class in options');

	const indicatorService = parameters.indicatorService || null;
	if (!indicatorService) throw new Error('registerTradingRoutes requires an indicatorService instance in options');

	const marketDataService = parameters.marketDataService || null;
	if (!marketDataService) throw new Error('registerTradingRoutes requires a marketDataService instance in options');

	const marketAnalysisService = parameters.marketAnalysisService || null;
	if (!marketAnalysisService) throw new Error('registerTradingRoutes requires a marketAnalysisService instance in options');

	const logger = parameters.logger || null;
	if (!logger) throw new Error('registerTradingRoutes requires a logger instance in options');

	const oauthService = parameters.oauthService || null;
	if (!oauthService) throw new Error('registerTradingRoutes requires an oauthService instance in options');

	const webUIAuthService = parameters.webUIAuthService || null;
	if (!webUIAuthService) throw new Error('registerTradingRoutes requires a webUIAuthService instance in options');

	const mcpService = parameters.mcpService || null;
	if (!mcpService) throw new Error('registerTradingRoutes requires a mcpService instance in options');

	const isSecuredServer = parameters.isSecuredServer !== undefined ? parameters.isSecuredServer : true;

	const rateLimiter = makeLimiter({ logger, max: 100 });

	// ========== Channel : OAUTH / Type : Authentication ==========

	const oauthRoutes = oauthService.getRoutes();

	oauthRoutes.forEach((route) => {
		const middleware = [];
		middleware.push(rateLimiter);
		middleware.push(route.handler.bind(oauthService));
		app[route.method](route.path, ...middleware);
		/*
		if (route.path === '/oauth/token') middleware.push(tokenLimiter);
		else if (route.path.startsWith('/oauth/')) middleware.push(oauthLimiter);
		*/
	});

	// ========== Channel : WEBUI / Type : Authentication ==========

	const webUIAuthRoutes = webUIAuthService.getRoutes();

	webUIAuthRoutes.forEach((route) => {
		const middleware = [];
		middleware.push(rateLimiter);
		middleware.push(route.handler);
		app[route.method](route.path, ...middleware);
	});

	// ========== Apply auth middleware ==========

	const authMiddleware = createAuthMiddleware(oauthService);

	// Apply auth middleware to API routes AND WebUI static files
	app.use((req, res, next) => {
		// Public paths that don't require authentication
		const publicPaths = ['/login.html', '/auth-client.js'];
		if (publicPaths.includes(req.path))
			return next();

		// API routes and MCP - require Bearer token OR cookie (only if server is secured)
		if (req.path.startsWith('/api/') || req.path.startsWith('/mcp')) {
			if (isSecuredServer) {
				// Try Bearer token first
				const authHeader = req.headers.authorization;
				if (authHeader && authHeader.startsWith('Bearer ')) {
					return authMiddleware(req, res, next);
				}

				// Try cookie as fallback (for WebUI requests)
				const token = req.cookies.webui_auth_token;
				if (token) {
					const validation = oauthService.validateToken(token);
					if (validation.valid) {
						req.user = { id: validation.payload.sub, scope: validation.payload.scope };
						return next();
					}
				}

				// No valid auth found
				return res.status(401).json({ error: 'Missing or invalid authentication' });
			}

			return next();
		}

		// WebUI static HTML files - ALWAYS check for valid token in HTTP-only cookie
		// This prevents client-side authentication bypass
		if (req.path.endsWith('.html') || req.path === '/' || req.path === '/index.html') {
			const token = req.cookies.webui_auth_token;

			// If no cookie or invalid token, redirect to login
			if (!token) 
				return res.redirect('/login.html');

			const validation = oauthService.validateToken(token);

			if (!validation.valid) {
				// Clear invalid cookie and redirect to login
				res.clearCookie('webui_auth_token');
				return res.redirect('/login.html');
			}

			// Token is valid, allow access
			req.user = { id: validation.payload.sub, scope: validation.payload.scope };
			return next();
		}

		// For other static files (JS, CSS, etc), allow access
		// These will be blocked by browser if the HTML page couldn't load
		return next();
	});

	if (isSecuredServer) 
		logger.info('Authentication middleware enabled for API routes and WebUI (server-side)');
	 else 
		logger.info('Authentication middleware enabled for WebUI only (SECURED_SERVER=false)');

	// ========== Channel : MCP / Type : Inventory / Global Handlder ==========

	app.get('/mcp/tools', (req, res) => {
		logger.info('GET /mcp/tools - Returning registered tools');
		res.json({ tools: mcpService.getTools() });
	});

	app.post('/mcp', async (req, res) => {
		await mcpService.handleRequest(req, res);
	});

	// ========== Channel : API / Type : MARKET DATA ==========

	app.get(
		'/api/v1/price/:symbol',
		asyncHandler(async (req) => {
			const { symbol } = req.params;
			logger.info(`GET /api/v1/price/${symbol} - Fetching current price`);

			const price = await marketDataService.getPrice(symbol);

			return {
				symbol,
				timestamp: Date.now(),
				value: price,
			};
		})
	);

	app.get(
		'/api/v1/ohlcv',
		asyncHandler(async (req) => {
			const { symbol, timeframe, count, from, to, analysisDate } = parseTradingParams(req.query);
			logger.info('GET /api/v1/ohlcv - Fetching OHLCV');

			if (!symbol) {
				const error = new Error('symbol is required');
				error.statusCode = 400;
				throw error;
			}

			return await marketDataService.loadOHLCV({ symbol, timeframe, count, from, to, analysisDate });
		})
	);

	app.get(
		'/api/v1/pairs',
		asyncHandler(async (req) => {
			const { quoteAsset, baseAsset, status } = req.query;
			logger.info('GET /api/v1/pairs - Fetching available trading pairs');

			const pairs = await marketDataService.getPairs({ quoteAsset, baseAsset, status });

			return { count: pairs.length, pairs };
		})
	);

	app.delete(
		'/api/v1/cache',
		asyncHandler(async (req) => {
			const { symbol, timeframe } = req.query;
			logger.info('DELETE /api/v1/cache - Clearing cache', { symbol, timeframe });
			const cleared = dataProvider.clearCache({ symbol, timeframe });
			return { cleared, message: `${cleared} cache entries removed` };
		})
	);

	// ========== Channel : API / Type : INDICATORS ==========

	app.get(
		'/api/v1/catalog',
		asyncHandler(async (req) => {
			const { category } = req.query;
			logger.info('GET /api/v1/catalog - Fetching trading indicator catalog');

			return indicatorService.getCatalog(category);
		})
	);

	app.get(
		'/api/v1/indicator/:name',
		asyncHandler(async (req) => {
			const { name } = req.params;
			logger.info(`GET /api/v1/indicator/${name} - Fetching indicator metadata`);

			const metadata = indicatorService.getIndicatorMetadata(name);
			if (!metadata) {
				const error = new Error(`Indicator '${name}' does not exist`);
				error.statusCode = 404;
				throw error;
			}
			return metadata;
		})
	);

	app.get(
		'/api/v1/indicators/:indicator',
		asyncHandler(async (req) => {
			const { indicator } = req.params;
			const { symbol, config, analysisDate } = req.query;
			const { timeframe, bars } = parseTradingParams(req.query);
			logger.info(`GET /api/v1/indicators/${indicator} - Getting time series for ${symbol}${analysisDate ? ` at ${analysisDate}` : ''}`);

			if (!symbol) {
				const error = new Error('symbol is required');
				error.statusCode = 400;
				throw error;
			}

			return await indicatorService.getIndicatorTimeSeries({
				symbol,
				indicator,
				timeframe,
				bars,
				analysisDate,
				config: config ? JSON.parse(config) : {},
			});
		})
	);

	// ========== Channel : API / Type : REGIME DETECTION ==========

	app.get(
		'/api/v1/regime',
		asyncHandler(async (req) => {
			const { analysisDate } = req.query;
			const { symbol, timeframe, count } = parseTradingParams(req.query);
			logger.info(`GET /api/v1/regime - Detecting market regime${analysisDate ? ` at ${analysisDate}` : ''}`);

			if (!symbol) {
				const error = new Error('symbol is required');
				error.statusCode = 400;
				throw error;
			}

			return await marketAnalysisService.detectRegime({ symbol, timeframe, count, analysisDate });
		})
	);

	// ========== Channel : API / Type : STATISTICAL CONTEXT ==========

	app.get(
		'/api/v1/context/enriched',
		asyncHandler(async (req) => {
			const { symbol, long, medium, short, analysisDate } = req.query;
			logger.info(`GET /api/v1/context/enriched - Unified enriched context${analysisDate ? ` at ${analysisDate}` : ''}`);

			if (!symbol) {
				const error = new Error('symbol is required');
				error.statusCode = 400;
				throw error;
			}

			// Build timeframes object from query parameters
			const timeframesObj = {};
			if (long) timeframesObj.long = long;
			if (medium) timeframesObj.medium = medium;
			if (short) timeframesObj.short = short;

			// Validate at least one timeframe is provided
			if (Object.keys(timeframesObj).length === 0) {
				const error = new Error('At least one timeframe (long, medium, or short) is required. Example: ?long=1w&medium=1d&short=1h');
				error.statusCode = 400;
				throw error;
			}

			return await marketAnalysisService.generateEnrichedContext({
				symbol,
				timeframes: timeframesObj,
				analysisDate,
			});
		})
	);

	app.get(
		'/api/v1/context/mtf-quick',
		asyncHandler(async (req) => {
			const { symbol, long, medium, short } = req.query;
			logger.info('GET /api/v1/context/mtf-quick - Quick multi-timeframe check');

			if (!symbol) {
				const error = new Error('symbol is required');
				error.statusCode = 400;
				throw error;
			}

			// Build timeframes object from query parameters
			const timeframesObj = {};
			if (long) timeframesObj.long = long;
			if (medium) timeframesObj.medium = medium;
			if (short) timeframesObj.short = short;

			// Validate at least 2 timeframes provided
			const tfCount = Object.keys(timeframesObj).length;
			if (tfCount < 2) {
				const error = new Error('At least 2 timeframes required for multi-timeframe analysis. Example: ?long=1w&medium=1d&short=1h');
				error.statusCode = 400;
				throw error;
			}

			return await marketAnalysisService.quickMultiTimeframeCheck({
				symbol,
				timeframes: timeframesObj,
			});
		})
	);

	// ========== Channel : API / Type : BACKTESTING ==========

	app.post(
		'/api/v1/backtest',
		asyncHandler(async (req) => {
			// Support both 'interval' (new) and 'timeframe' (legacy) parameter names
			const { symbol, startDate, endDate, interval, timeframe } = req.body;
			const backtestInterval = interval || timeframe || '1h';

			logger.info(`POST /api/v1/backtest - Running backtest for ${symbol} from ${startDate} to ${endDate} (interval: ${backtestInterval})`);

			// Validation
			if (!symbol) {
				const error = new Error('symbol is required');
				error.statusCode = 400;
				throw error;
			}

			if (!startDate || !endDate) {
				const error = new Error('startDate and endDate are required');
				error.statusCode = 400;
				throw error;
			}

			// Validate interval
			const validIntervals = ['1h', '4h', '1d'];
			if (!validIntervals.includes(backtestInterval)) {
				const error = new Error(`Invalid interval: ${backtestInterval}. Must be one of: ${validIntervals.join(', ')}`);
				error.statusCode = 400;
				throw error;
			}

			// Import BacktestingService dynamically
			const { BacktestingService } = await import('./Trading/Backtesting/BacktestingService.js');

			// Use existing MarketAnalysisService instance
			const backtestingService = new BacktestingService({
				logger,
				marketAnalysisService
			});

			// Run backtest (service handles date validation)
			const results = await backtestingService.runBacktest({
				symbol,
				startDate,
				endDate,
				interval: backtestInterval
			});

			return results;
		})
	);

	// ========== Channel : API / Type : UTILITY ==========

	app.get(
		'/api/v1/config',
		asyncHandler(() => {
			logger.info('GET /api/v1/config - Getting client configuration');
			return {
				timezone: process.env.TIMEZONE || 'Europe/Paris',
			};
		})
	);

	app.get(
		'/api/v1/status',
		asyncHandler(() => {
			return { status: 'ok' };
		})
	);

	// ========== Channel : API / Type : CACHE MANAGEMENT ==========

	app.get(
		'/api/v1/cache/stats',
		asyncHandler(async () => {
			logger.info('GET /api/v1/cache/stats - Getting cache statistics');
			return await dataProvider.getCacheStats();
		})
	);

	app.delete(
		'/api/v1/cache',
		asyncHandler(async (req) => {
			const { symbol, timeframe } = req.query;
			logger.info(`DELETE /api/v1/cache - Clearing cache for ${symbol || 'all'}:${timeframe || 'all'}`);

			const cleared = await dataProvider.clearCache({ symbol, timeframe });

			return {
				success: true,
				cleared,
				message: `Cleared ${cleared} cache item(s)`,
			};
		})
	);

	logger.info('Oauth/MCP/API routes registered.');
}

export default registerRoutes;
