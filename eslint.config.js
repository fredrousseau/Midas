import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    files: ["**/*.{js,mjs,cjs}"],
    plugins: { js },
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2021,
        ...globals.node,
      },
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["warn", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }],
      "curly": ["error", "multi", "consistent"],
      // Disallow more than one consecutive empty line (auto-fixable)
      "no-multiple-empty-lines": ["error", { "max": 1, "maxEOF": 0 }]
    },
  },
  // WebUI browser scripts loaded as plain <script> tags (not ES modules)
  // auth-client.js is excluded because it uses `export default` (type="module")
  {
    files: [
      "src/WebUI/app.js",
      "src/WebUI/data-panel.js",
      "src/WebUI/indicators-ui.js",
      "src/WebUI/tab-manager.js",
    ],
    languageOptions: {
      sourceType: "script",
      globals: {
        // Third-party libs loaded via CDN <script>
        LightweightCharts: "readonly",
        // Globals defined in app.js, used by other script files
        mainChart:              "writable",
        candlestickSeries:      "writable",
        indicatorChart:         "writable",
        currentData:            "writable",
        indicatorSeries:        "writable",
        indicatorDescriptions:  "writable",
        seriesDisplayNames:     "writable",
        appTimezone:            "writable",
        isSyncingCharts:        "writable",
        // Functions defined in app.js, called from other script files
        fetchCatalog:           "writable",
        showStatus:             "readonly",
        hideStatus:             "readonly",
        addIndicator:           "readonly",
        resizeCharts:           "readonly",
        authenticatedFetch:     "readonly",
        // Functions/vars defined in data-panel.js, called from app.js
        initDataPanel:          "writable",
        setupChartClickListeners: "writable",
        dataPanelOpen:          "writable",
        currentClickedData:     "writable",
        // Functions defined in indicators-ui.js, called from app.js
        buildIndicatorUI:       "writable",
        // catalogData is a global var in app.js (also used in indicators-ui.js)
        catalogData:            "writable",
      },
    },
  },
]);
