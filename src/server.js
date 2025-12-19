/**
 * @fileoverview Midas Trading Platform Server
 *
 * This is the main entry point for the Midas trading platform server.
 * It initializes and configures all core services including:
 * - OAuth authentication
 * - MCP (Model Context Protocol) service
 * - Data providers (Binance)
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

import { logger } from './Logger/LoggerService.js';

import { OAuthService } from './OAuth/OAuthService.js';
import { WebUIAuthService } from './OAuth/WebUIAuthService.js';
import { McpService } from './Mcp/McpService.js';

import { registerRoutes } from './routes.js';
import { hasKeys } from './Utils/helpers.js';

import { BinanceAdapter } from './DataProvider/BinanceAdapter.js';
import { DataProvider } from './DataProvider/DataProvider.js';

import { MarketDataService } from './Trading/MarketData/MarketDataService.js';
import { IndicatorService } from './Trading/Indicator/IndicatorService.js';
import { MarketAnalysisService } from './Trading/MarketAnalysis/MarketAnalysisService.js';

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
	logger: logger
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
 * Adapter for fetching data from Binance API
 * @type {BinanceAdapter}
 */
const binanceAdapter = new BinanceAdapter({
	logger: logger,
	baseUrl: 'https://api.binance.com',
});

/**
 * Data Provider Service
 * Generic data provider with caching capabilities
 * @type {DataProvider}
 */
const dataProvider = new DataProvider({
	dataAdapter: binanceAdapter,
	logger: logger,
	enableCache: true,
	cacheTTL: 60000, // 60 seconds
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
 * Market Analysis Service
 * Performs market analysis using indicators and market data
 * @type {MarketAnalysisService}
 */
const marketAnalysisService = new MarketAnalysisService({
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
	marketAnalysisService: marketAnalysisService,
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
	markerAnalysisService: marketAnalysisService,
	isSecuredServer: isSecuredServer
});

// ============================================================================
// STATIC FILES & ERROR HANDLERS
// ============================================================================

/**
 * Serve static files for the Web UI
 * Note: This is placed AFTER API routes so API routes take precedence
 * Authentication is handled client-side in app.js which redirects to login if not authenticated
 */
if (isSecuredServer) {
	// Serve all static files without server-side authentication
	// Client-side JavaScript (app.js) will check authentication and redirect if needed
	app.use(express.static('src/WebUI'));
	logger.info('WebUI static files served (client-side authentication enabled)');
} else {
	app.use(express.static('src/WebUI'));
	logger.warn('WebUI served WITHOUT authentication (SECURED_SERVER=false)');
}

/**
 * 404 Error Handler
 * Catch-all middleware for undefined routes (must be last)
 */
app.use((req, res) => {
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