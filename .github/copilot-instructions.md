# GitHub Copilot Instructions for Midas Trading Platform

## Project Overview
Midas is a Node.js-based multi-timeframe trading analysis platform that transforms raw market data into actionable trading decisions through a 5-layer hierarchical architecture. It integrates with Binance API, uses Redis caching, and supports MCP (Model Context Protocol) for AI assistant integration.

## Core Architecture
**5-Layer Architecture:**
1. **Infrastructure**: BinanceAdapter → DataProvider (Redis cache)
2. **Technical Calculation**: IndicatorService (40+ indicators)
3. **Contextual Analysis**: RegimeDetection + StatisticalContext (6 parallel enrichers)
4. **Decision & Strategy**: MarketAnalysisService + TradingContextService
5. **API Exposure**: REST endpoints + WebUI

**Key Services Flow:**
- `MarketAnalysisService.analyze()` orchestrates analysis
- `StatisticalContextService.generateFullContext()` gathers multi-timeframe data
- 6 Enrichers run in parallel: Momentum, Volatility, Volume, MovingAverages, PriceAction, Patterns
- `RegimeDetectionService` identifies 9 market regimes (trending/ranging/breakout × bull/bear/neutral)
- `TradingContextService` produces actionable recommendations

## Critical Configuration
**NEVER hardcode values** - All parameters centralized in `src/Trading/MarketAnalysis/config/`:
- `barCounts.js`: OHLCV_BAR_COUNTS, INDICATOR_BAR_COUNTS, EMA200_BAR_COUNTS
- `lookbackPeriods.js`: STATISTICAL_PERIODS, TREND_PERIODS, PATTERN_PERIODS

**Validation:** Configuration errors prevent server startup. OHLCV counts must be ≥ INDICATOR counts + 50 bars margin.

## Development Setup
- **Node.js v20.x required** (enforced at startup)
- **Redis critical for performance** - Enable in `.env`: `REDIS_ENABLED=true`
- **Environment**: Copy `.env.sample` to `.env`, set `SECURED_SERVER=false` for development
- **Path aliases**: Use `#utils/*`, `#trading/*`, `#data/*`, `#logger`, `#mcp/*` imports

## Service Initialization Pattern
All services require specific dependencies in constructor options:
```javascript
const marketAnalysisService = new MarketAnalysisService({
  logger: logger,
  dataProvider: dataProvider,      // Required
  indicatorService: indicatorService  // Required
});
```
Missing dependencies throw "requires X instance in options" errors.

## API Patterns
**DataProvider usage:**
- Method: `loadOHLCV(options)` (NOT `getOHLCV`)
- Parameters: `{ symbol, timeframe, count, from, to, referenceDate }`
- Timestamps: Use `date.getTime()` (milliseconds), not Date objects

**Route handlers:**
- Use `asyncHandler` wrapper for automatic error handling
- Success: Returns `{ success: true, data: result }`
- Errors: Returns `{ success: false, error: { type, message } }`

**Dual authentication:**
- API routes accept: `Bearer token` header OR `webui_auth_token` cookie
- WebUI uses HTTP-only cookies for security

## Testing & Validation
**Test suites:**
- `./scripts/RUN_ALL_TESTS.sh` - Master runner (expect 90/91 tests passing)
- `validate-critical-fixes.js` - 20 config validation tests
- `test-enrichers-functional.js` - 41 functional tests with mock data
- `test-integration-api.js` - 30 real service integration tests

**Validation:** Run tests after any config or logic changes.

## Common Pitfalls
1. **Date handling**: Always `date.getTime()` for API timestamps
2. **Error extraction**: Frontend uses `errorData.error.message` (nested structure)
3. **Cache performance**: Without Redis, each analysis hits Binance API repeatedly
4. **Service dependencies**: Check constructor requirements before instantiation
5. **Configuration sync**: Bar counts and lookback periods must be coordinated

## File Structure Reference
```
src/
├── DataProvider/          # Market data + Redis cache
├── Trading/MarketAnalysis/config/  # ⚠️ CRITICAL: All parameters
├── Trading/Indicator/     # 40+ technical indicators
├── Trading/MarketAnalysis/  # Core analysis engine
├── OAuth/                 # Authentication
├── WebUI/                 # HTML/JS interface
├── routes.js              # API endpoints
└── server.js              # Service initialization
```

## Performance Considerations
- Redis caching essential for production (prevents API rate limits)
- Multi-timeframe analysis exponentially increases API calls without cache
- Bar counts trade-off: Higher = more context but slower/slower API calls
- Backtesting without Redis: Thousands of API calls (slow + rate limit risk)

## Key Commands
- `npm start` - Standard server (with Node v20 check)
- `npm run debug` - Enhanced logging
- `./scripts/RUN_ALL_TESTS.sh` - Full test suite
- `LOG_LEVEL=verbose npm start` - Debug logging

## Documentation
- `CLAUDE.md` - Development guide with examples
- `docs/TRADING.md` - Complete architecture (French)
- `docs/CONFIGURABLE_PARAMETERS.md` - All 200+ parameters
- `docs/BACKTESTING_GUIDE.md` - Backtesting usage</content>
<parameter name="filePath">/Users/fred/Desktop/CodeBase/Midas/.github/copilot-instructions.md