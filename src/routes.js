/**
 * MCP & API Routes
 */

import { asyncHandler, parseTradingParams } from './Utils/helpers.js';
import { BinanceAdapter } from './DataProvider/BinanceAdapter.js';
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

	const marketContextService = parameters.marketContextService || null;
	if (!marketContextService) throw new Error('registerTradingRoutes requires a marketContextService instance in options');

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
		if (req.path.startsWith('/api/') || req.path.startsWith('/api/v1/mcp')) {
			if (isSecuredServer) {
				// Try Bearer token first
				const authHeader = req.headers.authorization;
				if (authHeader && authHeader.startsWith('Bearer ')) 
					return authMiddleware(req, res, next);

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

	app.get('/api/v1/mcp/tools', (req, res) => {
		logger.info('GET /api/v1/mcp/tools - Returning registered tools');
		res.json({ tools: mcpService.getTools() });
	});

	app.post('/api/v1/mcp', async (req, res) => {
		await mcpService.handleRequest(req, res);
	});

	// ========== Channel : API / Type : MARKET DATA ==========

	app.get(
		'/api/v1/market-data/price/:symbol',
		asyncHandler(async (req) => {
			const { symbol } = req.params;
			logger.info(`GET /api/v1/market-data/price/${symbol} - Fetching current price`);

			const price = await marketDataService.getPrice(symbol);

			return {
				symbol,
				timestamp: Date.now(),
				value: price,
			};
		})
	);

	app.get(
		'/api/v1/market-data/ohlcv',
		asyncHandler(async (req) => {
			const { symbol, timeframe, count, from, to, referenceDate } = parseTradingParams(req.query);
			logger.info('GET /api/v1/market-data/ohlcv - Fetching OHLCV');

			if (!symbol) {
				const error = new Error('symbol is required');
				error.statusCode = 400;
				throw error;
			}

			return await marketDataService.loadOHLCV({ symbol, timeframe, count, from, to, referenceDate });
		})
	);

	app.get(
		'/api/v1/market-data/pairs',
		asyncHandler(async (req) => {
			const { quoteAsset, baseAsset, status } = req.query;
			logger.info('GET /api/v1/market-data/pairs - Fetching available trading pairs');

			const pairs = await marketDataService.getPairs({ quoteAsset, baseAsset, status });

			return { count: pairs.length, pairs };
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
		'/api/v1/cache/clear',
		asyncHandler(async (req) => {
			const { symbol, timeframe } = req.query;
			logger.info(`DELETE /api/v1/cache/clear - Clearing cache for ${symbol || 'all'}:${timeframe || 'all'}`);

			const cleared = await dataProvider.clearCache({ symbol, timeframe });

			return {
				success: true,
				cleared,
				message: `Cleared ${cleared} cache item(s)`,
			};
		})
	);

	// ========== Channel : API / Type : INDICATORS ==========

	app.get(
		'/api/v1/indicators/catalog',
		asyncHandler(async (req) => {
			const { category } = req.query;
			logger.info('GET /api/v1/indicators/catalog - Fetching trading indicator catalog');

			return indicatorService.getCatalog(category);
		})
	);

	app.get(
		'/api/v1/indicators/:name',
		asyncHandler(async (req) => {
			const { name } = req.params;
			logger.info(`GET /api/v1/indicators/${name} - Fetching indicator metadata`);

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
		'/api/v1/indicators/:name/series',
		asyncHandler(async (req) => {
			const { name } = req.params;
			const { symbol, config, referenceDate } = req.query;
			const { timeframe, bars } = parseTradingParams(req.query);
			logger.info(`GET /api/v1/indicators/${name}/series - Getting time series for ${symbol}${referenceDate ? ` at ${referenceDate}` : ''}`);

			if (!symbol) {
				const error = new Error('symbol is required');
				error.statusCode = 400;
				throw error;
			}

			return await indicatorService.getIndicatorTimeSeries({
				symbol,
				indicator: name,
				timeframe,
				bars,
				referenceDate,
				config: config ? JSON.parse(config) : {},
			});
		})
	);

	// ========== Channel : API / Type : REGIME DETECTION ==========

	app.get(
		'/api/v1/regime/detect',
		asyncHandler(async (req) => {
			const { referenceDate } = req.query;
			const { symbol, timeframe, count } = parseTradingParams(req.query);
			logger.info(`GET /api/v1/regime/detect - Detecting market regime${referenceDate ? ` at ${referenceDate}` : ''}`);

			if (!symbol) {
				const error = new Error('symbol is required');
				error.statusCode = 400;
				throw error;
			}

			return await marketContextService.detectRegime({ symbol, timeframe, count, referenceDate });
		})
	);

	// ========== Channel : API / Type : STATISTICAL CONTEXT ==========

	app.get(
		'/api/v1/context',
		asyncHandler(async (req) => {
			const { symbol, long, medium, short, referenceDate } = req.query;
			logger.info(`GET /api/v1/context - Multi-timeframe context${referenceDate ? ` at ${referenceDate}` : ''}`);

			// Validate required parameters
			const errors = [];

			if (!symbol)
				errors.push('symbol is required (e.g. BTCUSDT)');
			else if (typeof symbol !== 'string' || !/^[A-Z0-9]+$/.test(symbol))
				errors.push(`symbol '${symbol}' is invalid — must be uppercase alphanumeric (e.g. BTCUSDT)`);

			// Validate timeframes
			const validTimeframes = BinanceAdapter.VALID_TIMEFRAMES;
			const timeframesObj = {};

			if (!long && !medium && !short) {
				errors.push('At least one timeframe (long, medium, or short) is required. Example: ?long=1w&medium=1d&short=1h');
			} else {
				if (long)
					if (!validTimeframes.includes(long))
						errors.push(`long '${long}' is not a valid timeframe. Valid: ${validTimeframes.join(', ')}`);
					else
						timeframesObj.long = long;

				if (medium)
					if (!validTimeframes.includes(medium))
						errors.push(`medium '${medium}' is not a valid timeframe. Valid: ${validTimeframes.join(', ')}`);
					else
						timeframesObj.medium = medium;

				if (short)
					if (!validTimeframes.includes(short))
						errors.push(`short '${short}' is not a valid timeframe. Valid: ${validTimeframes.join(', ')}`);
					else
						timeframesObj.short = short;
			}

			// Validate referenceDate format if provided
			if (referenceDate && isNaN(Date.parse(referenceDate)))
				errors.push(`referenceDate '${referenceDate}' is not a valid date. Expected format: YYYY-MM-DD or ISO 8601`);

			if (errors.length > 0) {
				const error = new Error(errors.join('; '));
				error.statusCode = 400;
				throw error;
			}

			return await marketContextService.generateContext({
				symbol,
				timeframes: timeframesObj,
				referenceDate,
			});
		})
	);

	// ========== Channel : API / Type : UTILITY ==========

	app.get(
		'/api/v1/utility/config',
		asyncHandler(() => {
			logger.info('GET /api/v1/utility/config - Getting client configuration');
			return {
				timezone: process.env.TIMEZONE || 'Europe/Paris',
			};
		})
	);

	app.get(
		'/api/v1/utility/status',
		asyncHandler(() => {
			return { status: 'ok' };
		})
	);

	logger.info('Oauth/MCP/API routes registered.');
}

export default registerRoutes;
