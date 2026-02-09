# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Midas is a multi-timeframe trading analysis platform that transforms raw market data into actionable trading context through a 5-layer hierarchical architecture. Built on Node.js v20.x with Express, Binance API, Redis caching, OAuth 2.0 authentication, and MCP (Model Context Protocol) integration.

## Development Commands

```bash
npm start                                    # Standard mode (enforces Node.js v20.x via prestart)
npm run debug                                # Debug mode (enhanced logging)
LOG_LEVEL=verbose npm start                  # Verbose logging

# Testing
./scripts/RUN_ALL_TESTS.sh                   # Run all test suites
node scripts/validate-critical-fixes.js      # 14 tests - Config validation
node scripts/test-enrichers-functional.js    # 42 tests - Enricher lookback periods with mock data
node scripts/test-integration-api.js         # 13 tests - Real service imports and execution
```

## Environment Setup

Copy `.env.sample` to `.env`. Key settings:
- `SECURED_SERVER=false` for development (skips OAuth on API routes)
- `REDIS_ENABLED=true` if Redis is running (critical for avoiding Binance rate limits)
- `LOG_LEVEL=verbose` for detailed debugging
- `NODE_ENV=development` for stack traces in error responses
- `MAX_DATA_POINTS=5000` - Maximum bars per API request

## Architecture

### 5-Layer Pipeline

```
LAYER 1: Infrastructure (BinanceAdapter -> DataProvider with Redis cache)
    |
LAYER 2: Technical Calculation (IndicatorService - 40+ indicators)
    |
LAYER 3: Contextual Analysis (RegimeDetectionService + StatisticalContextService with 6 Enrichers)
    |
LAYER 4: Context Generation (MarketContextService - orchestrates layers 1-3)
    |
LAYER 5: API Exposure (REST endpoints + WebUI)
```

### Key Services Flow

1. `MarketContextService.generateContext()` / `.generateLLMContext()` - Entry point
2. `StatisticalContextService.generateFullContext()` - Gathers multi-timeframe statistical data
3. 6 Enrichers execute in parallel: Momentum, Volatility, Volume, MovingAverages, PriceAction, Patterns
4. `RegimeDetectionService` - Identifies market regime (9 types: trending/ranging/breakout x bull/bear/neutral)
5. Alignment analysis - Weighted multi-timeframe scoring
6. Returns complete context (raw technical data or LLM-optimized format)

### Critical Configuration

**DO NOT hardcode values** - All parameters are centralized in `src/Trading/MarketContext/config/`:

- **`barCounts.js`** - OHLCV_BAR_COUNTS, INDICATOR_BAR_COUNTS, EMA200_BAR_COUNTS, REGIME_MIN_BARS
  - Rule: OHLCV count must be >= INDICATOR count + 50 bars margin
- **`lookbackPeriods.js`** - STATISTICAL_PERIODS, TREND_PERIODS, PATTERN_PERIODS, VOLUME_PERIODS, SUPPORT_RESISTANCE_PERIODS, PATTERN_ATR_MULTIPLIERS

Validation runs at module load - configuration errors prevent server startup.

## Important Code Patterns

### Path Aliases (package.json imports)

```javascript
import { something } from '#utils/helpers.js';    // ./src/Utils/*
import { Service } from '#trading/Module/File.js'; // ./src/Trading/*
import { logger } from '#logger';                  // ./src/Logger/LoggerService.js
import { Mcp } from '#mcp/McpService.js';          // ./src/Mcp/*
import { Data } from '#data/File.js';              // ./src/Data/*
```

### Async Route Handler

All routes use `asyncHandler` wrapper - return values are automatically wrapped in `{ success: true, data: ... }`. Errors are caught by the global error handler. Set `error.statusCode` for non-500 responses.

### Dual Authentication

API routes accept both Bearer token (Authorization header) and HTTP-only cookie (`webui_auth_token`). When `SECURED_SERVER=false`, API routes skip auth entirely but WebUI still requires cookie auth.

### Error Response Structure

```javascript
{ success: false, error: { type: "Error", message: "Actual error message" } }
```

Frontend must extract `errorData.error.message` (not `errorData.error` which is an object).

### Service Dependencies

`MarketContextService` requires `logger`, `dataProvider`, `indicatorService` in constructor options. Missing any causes "requires X instance in options" error.

### DataProvider Usage

- Method: `loadOHLCV(options)` - NOT `getOHLCV`
- Parameters: `{ symbol, timeframe, count, from, to, analysisDate }`
- `to` must be **timestamp in milliseconds** (`date.getTime()`), not a Date object

## API Endpoints

**Context (main analysis):**
- `GET /api/v1/context/enriched?symbol=BTCUSDT&long=1d&medium=4h&short=1h` - Full multi-timeframe context
- `GET /api/v1/context/llm?symbol=BTCUSDT&long=1d&medium=4h&short=1h` - LLM-optimized context

**Market Data:**
- `GET /api/v1/market-data/price/:symbol` - Current price
- `GET /api/v1/market-data/ohlcv?symbol=BTCUSDT&timeframe=1h&count=100` - Historical candles
- `GET /api/v1/market-data/pairs` - Available trading pairs

**Indicators:**
- `GET /api/v1/indicators/catalog` - List all available indicators
- `GET /api/v1/indicators/:name` - Indicator metadata
- `GET /api/v1/indicators/:name/series?symbol=BTCUSDT&timeframe=1h&bars=200` - Indicator time series

**Regime Detection:**
- `GET /api/v1/regime/detect?symbol=BTCUSDT&timeframe=1h` - Detect market regime

**Cache Management:**
- `GET /api/v1/cache/stats` - Cache statistics
- `DELETE /api/v1/cache/clear` - Clear cache (optional `?symbol=&timeframe=`)

**MCP:**
- `GET /api/v1/mcp/tools` - List MCP tools
- `POST /api/v1/mcp` - MCP request handler

**Utility:**
- `GET /api/v1/utility/config` - Client configuration (timezone)
- `GET /api/v1/utility/status` - Health check

## File Structure

```
src/
  DataProvider/              # BinanceAdapter, DataProvider (Redis cache), CacheManager
  Trading/
    Indicator/               # 40+ technical indicators (IndicatorService)
    MarketData/              # OHLCV data service (MarketDataService)
    MarketContext/            # Core analysis engine
      MarketContextService.js      # Orchestrator - entry point for all analysis
      StatisticalContextService.js # Multi-timeframe statistical data
      RegimeDetectionService.js    # Market regime classification
      config/                      # barCounts.js, lookbackPeriods.js
      enrichers/                   # 6 enrichers: Momentum, Volatility, Volume,
                                   # MovingAverages, PriceAction, PatternDetector
  OAuth/                     # OAuthService, WebUIAuthService
  Mcp/                       # Model Context Protocol service
  WebUI/                     # Web interface (HTML/JS/CSS)
  Logger/                    # Winston logging with daily rotation
  Utils/                     # Helpers (asyncHandler, parseTradingParams, etc.)
  routes.js                  # All API endpoint definitions
  server.js                  # Main entry point, service initialization

scripts/
  RUN_ALL_TESTS.sh           # Master test runner
  README_TESTS.md            # Testing documentation
```

## Linting

ESLint v9 with flat config (`eslint.config.js`). Key rules: `no-undef` (error), `no-unused-vars` (warn, ignores `_` prefixed), `curly` (multi/consistent), `no-multiple-empty-lines` (max 1).

## Common Pitfalls

1. **Date vs Timestamp** - Binance API expects numeric timestamps. Always use `date.getTime()`, never pass Date objects to `loadOHLCV`.
2. **Method names** - `loadOHLCV` not `getOHLCV`. `generateContext` / `generateLLMContext` not `analyze`.
3. **Error display** - Extract `errorData.error.message`, not `errorData.error` (shows "[object Object]").
4. **Redis** - Without it, every analysis hits Binance API directly. Check with `redis-cli ping`.
5. **Config sync** - Bar counts and lookback periods must be coordinated. OHLCV >= INDICATOR + 50 margin.

## Documentation

- `docs/DOCUMENTATION.md` - Complete technical documentation (French)
- `scripts/README_TESTS.md` - Testing guide
