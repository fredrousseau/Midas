/**
 * @fileoverview Midas Trading Platform Server
 *
 * This is the main entry point for the Midas trading platform server.
 * It initializes and configures all core services including:
 * - OAuth authentication
 * - MCP (Model Context Protocol) service
 * - Data providers (Binance + Yahoo Finance via AdapterRouter)
 * - Market data, indicators, and analysis services
 * - Express server with CORS, logging, and routing
 *
 * @requires dotenv/config - Environment variables configuration
 * @requires express - Web framework
 * @requires cors - Cross-Origin Resource Sharing middleware
 */

// Environment is loaded via import 'dotenv/config' at file top so other modules see process.env
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { logger } from './Logger/LoggerService.js';

import { OAuthService } from './OAuth/OAuthService.js';
import { WebUIAuthService } from './OAuth/WebUIAuthService.js';
import { McpService } from './Mcp/McpService.js';

import { registerRoutes } from './routes.js';
import { hasKeys } from './Utils/helpers.js';

import { BinanceAdapter } from './DataProvider/BinanceAdapter.js';
import { YahooFinanceAdapter } from './DataProvider/YahooFinanceAdapter.js';
import { AdapterRouter } from './DataProvider/AdapterRouter.js';
import { DataProvider } from './DataProvider/DataProvider.js';

import { MarketDataService } from './Trading/MarketData/MarketDataService.js';
import { IndicatorService } from './Trading/Indicator/IndicatorService.js';
import { MarketContextService } from './Trading/MarketContext/MarketContextService.js';

// ============================================================================
// SERVER CONFIGURATION
// ============================================================================

/**
 * Security flag to enable/disable authentication on routes
 * @type {boolean}
 * @default true
 * @env SECURED_SERVER - Set to 'false' to disable authentication
 */
const isSecuredServer = String(process.env.SECURED_SERVER || 'true').toLowerCase() === 'true';

/**
 * Express application instance
 * @type {express.Application}
 */
const app = express();

// ============================================================================
// MIDDLEWARE CONFIGURATION
// ============================================================================

/**
 * Trust Proxy Configuration
 * Enable this if the app is behind a reverse proxy (nginx, Apache, load balancer, etc.)
 * This allows Express to correctly identify client IPs from X-Forwarded-For headers
 * @env TRUST_PROXY - Trust proxy setting (default: 'loopback')
 * Values: true (trust all), false (trust none), 'loopback' (trust localhost), or specific IP/CIDR
 */
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');

/**
 * CORS Configuration
 * Allows cross-origin requests with credentials
 * @env CORS_ORIGIN - Allowed origin for CORS (default: '*')
 */
app.use(
	cors({
		origin: process.env.CORS_ORIGIN || '*',
		methods: ['GET', 'POST'],
		allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id'],
		credentials: true,
		maxAge: 86400, // 24 hours
	})
);

// Body parsing middleware
app.use(express.json()); // Parse application/json
app.use(express.urlencoded({ extended: true })); // Parse application/x-www-form-urlencoded
app.use(cookieParser()); // Parse cookies

/**
 * HTTP Request Logger Middleware
 * Logs all incoming requests with method, path, status code, duration, body, and query params
 */
app.use((req, res, next) => {
	const start = Date.now();

	res.once('finish', () => {
		const duration = Date.now() - start;
		logger.verbose(`${req.ip} ${req.method} ${req.path} - ${res.statusCode} - ${duration}ms`);
	});

	if (hasKeys(req.body)) logger.verbose({ tag: 'Incoming Body', body: req.body });
	if (hasKeys(req.query)) logger.verbose({ tag: 'Incoming Query', query: req.query });

	next();
});

// ============================================================================
// SERVICE INITIALIZATION
// ============================================================================

/**
 * OAuth Service
 * Handles OAuth 2.0 authentication flow
 * @type {OAuthService}
 */
const oauthService = new OAuthService({
	logger: logger,
	isSecuredServer: isSecuredServer
});

/**
 * WebUI Authentication Service
 * Handles simple username/password authentication for WebUI access
 * @type {WebUIAuthService}
 */
const webUIAuthService = new WebUIAuthService({
	logger: logger,
	oauthService: oauthService
});

/**
 * Binance Data Adapter
 * Adapter for fetching data from Binance API (crypto pairs: BTCUSDT, ETHUSDT, …)
 * @type {BinanceAdapter}
 */
const binanceAdapter = new BinanceAdapter({
	logger: logger,
	baseUrl: 'https://api.binance.com',
});

/**
 * Yahoo Finance Data Adapter
 * Adapter for fetching data from Yahoo Finance (stocks, ETFs, indices: MC.PA, AAPL, ^FCHI, …)
 * @type {YahooFinanceAdapter}
 */
const yahooAdapter = new YahooFinanceAdapter({
	logger: logger,
	timeout: 15000,
});

/**
 * Adapter Router
 * Routes requests to BinanceAdapter or YahooFinanceAdapter based on symbol format.
 * @type {AdapterRouter}
 */
const adapterRouter = new AdapterRouter({
	binanceAdapter,
	yahooAdapter,
	logger,
});

/**
 * Redis Configuration
 * Parse Redis settings from environment variables
 */
const redisConfig = {
	enabled: String(process.env.REDIS_ENABLED || 'false').toLowerCase() === 'true',
	host: process.env.REDIS_HOST || 'localhost',
	port: parseInt(process.env.REDIS_PORT || '6379'),
	password: process.env.REDIS_PASSWORD || undefined,
	db: parseInt(process.env.REDIS_DB || '0'),
	ttl: parseInt(process.env.REDIS_CACHE_TTL || '300'), // TTL in seconds
	maxBars: parseInt(process.env.REDIS_MAX_BARS_PER_KEY || '10000'), // Max bars per symbol:timeframe
};

/**
 * Data Provider Service
 * Generic data provider with caching capabilities
 * @type {DataProvider}
 */
const dataProvider = new DataProvider({
	dataAdapter: adapterRouter,
	logger: logger,
	maxDataPoints: parseInt(process.env.MAX_DATA_POINTS || '5000'),
	redisConfig: redisConfig,
});

/**
 * Market Data Service
 * Provides access to market data (prices, candles, tickers, etc.)
 * @type {MarketDataService}
 */
const marketDataService = new MarketDataService({
	logger: logger,
	dataProvider: dataProvider,
});

/**
 * Indicator Service
 * Calculates technical indicators (RSI, EMA, SMA, Bollinger Bands, etc.)
 * @type {IndicatorService}
 */
const indicatorService = new IndicatorService({
	logger: logger,
	dataProvider: dataProvider,
});

/**
 * Market Context Service
 * Generates market context using indicators and market data
 * @type {MarketContextService}
 */
const marketContextService = new MarketContextService({
	logger: logger,
	dataProvider: dataProvider,
	indicatorService: indicatorService,
});

/**
 * MCP (Model Context Protocol) Service
 * Manages MCP tools and resources for AI assistant integration
 * @type {McpService}
 */
const mcpService = new McpService({
	logger: logger,
	name: 'fredR',
	version: '1.0.0',
});

// ============================================================================
// MCP TOOL REGISTRATION
// ============================================================================

/**
 * Auto-registers all MCP tool modules dynamically
 * This scans for tool modules and registers them with the MCP service
 */
await mcpService.registerAllModules({
	mcpService: mcpService,
	logger: logger,
	dataProvider: dataProvider,
	marketDataService: marketDataService,
	indicatorService: indicatorService,
	marketContextService: marketContextService,
});

// ============================================================================
// ROUTES REGISTRATION
// ============================================================================

/**
 * Register all routes
 * Includes OAuth, MCP, market data, indicator, and analysis endpoints
 */
registerRoutes({
	app: app,
	oauthService: oauthService,
	webUIAuthService: webUIAuthService,
	mcpService: mcpService,
	logger: logger,
	dataProvider: dataProvider,
	marketDataService: marketDataService,
	indicatorService: indicatorService,
	marketContextService: marketContextService,
	isSecuredServer: isSecuredServer
});

// ============================================================================
// STATIC FILES & ERROR HANDLERS
// ============================================================================

/**
 * Serve static files for the Web UI
 * Note: This is placed AFTER API routes so API routes take precedence
 * Authentication is handled SERVER-SIDE via HTTP-only cookies in routes.js middleware
 * HTML files are protected and will redirect to /login.html if the cookie is missing or invalid
 */
app.use(express.static('src/WebUI'));

/**
 * Global error handler middleware
 * Catches all errors from any route and provides consistent error responses
 * Must be placed AFTER all routes but BEFORE the 404 handler
 */
app.use((err, req, res, next) => {
	// Build error details for logging
	const errorDetails = `${req.method} ${req.path} - ${err.message}`;
	const clientInfo = `[${req.ip || req.connection.remoteAddress}]`;

	// Determine log level based on error type
	if (err.statusCode && err.statusCode < 500) {
		logger.warn(`Client error ${clientInfo}: ${errorDetails}`);
	} else {
		logger.error(`Server error ${clientInfo}: ${errorDetails}`);
		// Log stack trace for server errors
		if (err.stack) 
			logger.error(`Stack trace:\n${err.stack}`);
		
	}

	// Don't send response if headers already sent
	if (res.headersSent) 
		return next(err);

	// Determine status code
	const statusCode = err.statusCode || err.status || 500;

	// Build error response
	const errorResponse = {
		success: false,
		error: {
			type: err.name || 'Error',
			message: err.message || 'An unexpected error occurred',
		},
	};

	// Include stack trace in development mode only
	if (process.env.NODE_ENV === 'development') 
		errorResponse.error.stack = err.stack;

	// Send error response
	res.status(statusCode).json(errorResponse);
});

/**
 * 404 Error Handler
 * Catch-all middleware for undefined routes (must be last)
 */
app.use((_req, res) => {
	res.status(404).json({ error: 'Route not found' });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

/**
 * HTTP server port
 * @type {number}
 * @env PORT - Server port (default: 3000)
 */
const PORT = process.env.PORT || 3000;

/**
 * Start the Express server
 * Listens on the configured port and handles startup errors
 */
app
	.listen(PORT, () => {
		logger.info(`Server running on http://localhost:${PORT} - Log Level: ${logger.level} - Secured Mode : ${isSecuredServer}`);
	})
	.on('error', (err) => {
		logger.error(`Server error: ${err.message}`);
		process.exit(1);
	});