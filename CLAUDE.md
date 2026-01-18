# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Midas is a sophisticated multi-timeframe trading analysis platform that transforms raw market data into actionable trading decisions through a 5-layer hierarchical architecture.

**Core Technologies:**
- Node.js v20.x (required, enforced at startup)
- Express.js (REST API)
- Binance API (market data source)
- Redis (optional caching layer)
- OAuth 2.0 (authentication)
- MCP (Model Context Protocol) integration

## Development Commands

### Running the Server

```bash
# Standard mode
npm start

# Debug mode (enhanced logging)
npm run debug

# The prestart script enforces Node.js v20.x
```

### Testing

```bash
# Run all test suites
./scripts/RUN_ALL_TESTS.sh

# Individual test suites
node scripts/validate-critical-fixes.js      # 20 tests - Config validation
node scripts/test-enrichers-functional.js    # 41 tests - Lookback periods with mock data
node scripts/test-integration-api.js         # 30 tests - Real service imports and execution

# Expected: 90/91 tests passing (98.9%)
```

### Environment Configuration

Copy `.env.sample` to `.env` and configure:

**Critical settings:**
- `SECURED_SERVER=false` for development (skips OAuth)
- `REDIS_ENABLED=true` if Redis is running (significantly improves performance)
- `LOG_LEVEL=verbose` for detailed debugging
- `NODE_ENV=development` for stack traces in error responses

**Redis configuration:**
```bash
# Install Redis (macOS)
brew install redis
brew services start redis

# Then enable in .env
REDIS_ENABLED=true
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_CACHE_TTL=300  # 5 minutes
REDIS_MAX_BARS_PER_KEY=10000
```

**Data provider settings:**
- `MAX_DATA_POINTS=5000` - Maximum bars per API request (increase if your data source supports more)
  - Binance supports up to ~1000-1500 depending on timeframe
  - Set higher for large historical analyses
  - DataProvider will validate against this limit

## Architecture Overview

### 5-Layer Architecture

```
LAYER 1: Infrastructure (BinanceAdapter → DataProvider)
    ↓
LAYER 2: Technical Calculation (IndicatorService - 40+ indicators)
    ↓
LAYER 3: Contextual Analysis (RegimeDetection + StatisticalContext with 6 Enrichers)
    ↓
LAYER 4: Decision & Strategy (MarketAnalysisService + TradingContextService)
    ↓
LAYER 5: API Exposure (REST endpoints + WebUI)
```

### Key Services Flow

**Market Analysis Request:**
1. `MarketAnalysisService.analyze()` - Entry point, orchestrates entire analysis
2. `StatisticalContextService.generateFullContext()` - Gathers multi-timeframe statistical data
3. 6 Enrichers execute in parallel (Momentum, Volatility, Volume, MovingAverages, PriceAction, Patterns)
4. `RegimeDetectionService` - Identifies market regime (9 types: trending/ranging/breakout × bull/bear/neutral)
5. Alignment analysis - Weighted multi-timeframe scoring
6. `TradingContextService.generateTradingContext()` - Produces actionable recommendations
7. Returns complete analysis with recommended_action (TRADE/PREPARE/CAUTION/WAIT)

### Critical Configuration Files

**DO NOT hardcode values** - All parameters are centralized:

1. **Bar Counts** (`src/Trading/MarketAnalysis/config/barCounts.js`)
   - OHLCV_BAR_COUNTS: How many bars to fetch per timeframe
   - INDICATOR_BAR_COUNTS: How many bars for indicator calculations
   - EMA200_BAR_COUNTS: Special requirements for long-period EMAs
   - REGIME_MIN_BARS: Minimum bars for regime detection
   - **Rule:** OHLCV count must be ≥ INDICATOR count + 50 bars margin

2. **Lookback Periods** (`src/Trading/MarketAnalysis/config/lookbackPeriods.js`)
   - STATISTICAL_PERIODS: For percentile calculations, mean/std
   - TREND_PERIODS: For slope calculations, trend detection
   - PATTERN_PERIODS: For swing detection, structure analysis
   - VOLUME_PERIODS: For volume analysis, OBV trends
   - SUPPORT_RESISTANCE_PERIODS: For S/R level identification
   - PATTERN_ATR_MULTIPLIERS: For swing significance thresholds

**Validation runs at module load** - configuration errors will prevent server startup.

### Data Flow Architecture

**Data Pipeline:**
- **MarketDataService** → DataProvider → Redis cache → BinanceAdapter (OHLCV data)
- **MarketAnalysisService** → StatisticalContext, RegimeDetection, TradingContext (full analysis)

**Key points:**
- Caching via Redis (DataProvider)
- **Redis is essential** for avoiding rate limits during intensive analysis

## Important Code Patterns

### Authentication Middleware

Routes support **dual authentication**:
```javascript
// API routes accept BOTH:
1. Bearer token in Authorization header (for API clients)
2. HTTP-only cookie webui_auth_token (for WebUI)

// Implementation in routes.js lines 117-141
```

### Error Handling Structure

Backend returns structured errors:
```javascript
{
  success: false,
  error: {
    type: "Error",
    message: "Actual error message"
  }
}
```

**Frontend must extract:** `errorData.error.message` (not `errorData.error` which is an object)

### Async Route Handler Pattern

All routes use `asyncHandler` wrapper:
```javascript
app.post('/api/v1/endpoint',
  asyncHandler(async (req) => {
    // Return value is automatically wrapped in { success: true, data: ... }
    return result;

    // Errors are caught and passed to global error handler
    // Set error.statusCode for non-500 responses
  })
);
```

### DataProvider Usage

**Correct method names:**
- `loadOHLCV(options)` - NOT `getOHLCV`
- Parameters: `{ symbol, timeframe, count, from, to, analysisDate }`
- `to` must be **timestamp in milliseconds** (use `date.getTime()`), not Date object

## Common Pitfalls

1. **Date to Timestamp Conversion**
   - Binance API expects numeric timestamps, not Date objects
   - Always use `date.getTime()` when passing dates to loadOHLCV

2. **Service Dependencies**
   - MarketAnalysisService requires: `dataProvider`, `indicatorService`, `logger`
   - Missing any dependency causes "requires X instance in options" error

3. **WebUI Error Display**
   - Error responses have nested structure: `errorData.error.message`
   - Don't display `errorData.error` directly (shows "[object Object]")

4. **Redis Caching**
   - Performance heavily depends on Redis being enabled
   - Check connection: `redis-cli ping` should return `PONG`
   - Logs show "Redis cache disabled" if REDIS_ENABLED=false or connection fails

## File Structure

```
src/
├── DataProvider/          # Market data fetching + Redis cache
│   ├── BinanceAdapter.js  # Binance API client
│   ├── DataProvider.js    # Cache layer
│   └── CacheManager.js    # Redis management
├── Trading/
│   ├── Indicator/         # 40+ technical indicators
│   ├── MarketData/        # OHLCV data service
│   ├── MarketAnalysis/    # Core analysis engine
│   │   ├── config/        # ⚠️ CRITICAL: All configurable parameters
│   │   ├── StatisticalContext/  # 6 Enrichers
│   │   ├── RegimeDetection/     # Market regime classification
│   │   └── TradingContext/      # Actionable recommendations
├── OAuth/                 # Authentication services
├── Mcp/                   # Model Context Protocol
├── WebUI/                 # Web interface (HTML/JS/CSS)
├── routes.js              # All API endpoint definitions
└── server.js              # Main entry point

scripts/
├── RUN_ALL_TESTS.sh       # Master test runner
├── validate-critical-fixes.js
├── test-enrichers-functional.js
└── test-integration-api.js

docs/
├── DOCUMENTATION.md       # Complete documentation
└── scripts/README_TESTS.md
```

## API Endpoints Reference

**Analysis:**
- `GET /api/v1/analysis?symbol=BTCUSDT&long=1d&medium=4h&short=1h` - Multi-timeframe analysis
- `GET /api/v1/quick-check?symbol=BTCUSDT&long=1d&medium=4h&short=1h` - Lightweight check

**Market Data:**
- `GET /api/v1/price/:symbol` - Current price
- `GET /api/v1/ohlcv?symbol=BTCUSDT&timeframe=1h&count=100` - Historical candles
- `GET /api/v1/pairs` - Available trading pairs

**Indicators:**
- `GET /api/v1/indicator/:indicator?symbol=BTCUSDT&timeframe=1h&bars=200`

## WebUI Access

Navigate to `http://localhost:3000` after starting the server.

**Available pages:**
- `/` - Main analysis dashboard

**Authentication:**
- Uses HTTP-only cookies (more secure than localStorage)
- Credentials from .env: `WEBUI_USERNAME` / `WEBUI_PASSWORD`
- Session persists across page refreshes

## Debugging Tips

1. **Enable verbose logging:**
   ```bash
   LOG_LEVEL=verbose npm start
   ```

2. **Check service initialization:**
   Look for these log messages at startup:
   - "DataProvider initialized with Redis-only cache" (or warning if disabled)
   - "IndicatorService initialized"
   - "MarketAnalysisService initialized"

3. **Monitor API calls:**
   - Each request logs: `{ip} {method} {path} - {status} - {duration}ms`
   - Watch for repeated identical requests (cache miss indicator)

4. **Common error patterns:**
   - "requires X instance in options" → Missing service dependency in constructor
   - "Illegal characters in parameter endTime" → Passing Date instead of timestamp
   - "is not a function" → Wrong method name (e.g., getOHLCV vs loadOHLCV)
   - "[object Object]" in UI → Incorrect error message extraction from backend

## Git Workflow

**Commits require Co-Authored-By tag:**
```bash
git commit -m "Your message

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

**Never force-push to main/master** without explicit user request.

## Performance Considerations

1. **Redis is critical for production** - Without it, every analysis hits Binance API
2. **Bar count trade-offs:**
   - Higher counts = more historical context but slower API calls
   - Lower counts = faster but less reliable indicators
   - Current defaults are optimized for balance (see barCounts.js)

3. **Multi-timeframe alignment:**
   - 3 timeframes typical: long (trend), medium (structure), short (entry timing)
   - More timeframes = exponentially more API calls without cache

## Documentation

Primary docs in `/docs`:
- `DOCUMENTATION.md` - Complete technical documentation
- `scripts/README_TESTS.md` - Testing guide

**These docs are comprehensive** - read them before making changes to analysis logic.
