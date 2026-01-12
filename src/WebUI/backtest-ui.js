/**
 * Backtest UI Logic
 * Frontend for MIDAS backtesting system
 */

// Global state
let currentResults = null;

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    initializeDates();
});

/**
 * Initialize date inputs with default values
 */
function initializeDates() {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30); // 30 days ago

    document.getElementById('endDate').valueAsDate = endDate;
    document.getElementById('startDate').valueAsDate = startDate;
}

/**
 * Run backtest
 */
window.runBacktest = async function() {
    const symbol = document.getElementById('symbol').value.trim();
    const timeframe = document.getElementById('timeframe').value;
    const startDate = document.getElementById('startDate').value;
    const endDate = document.getElementById('endDate').value;
    const minConfidence = parseFloat(document.getElementById('minConfidence').value) / 100;
    const minQuality = parseInt(document.getElementById('minQuality').value);

    // Validation
    if (!symbol) {
        showStatus('error', 'Le symbole est requis');
        return;
    }

    if (!startDate || !endDate) {
        showStatus('error', 'Les dates de début et de fin sont requises');
        return;
    }

    if (new Date(startDate) >= new Date(endDate)) {
        showStatus('error', 'La date de début doit être avant la date de fin');
        return;
    }

    // Disable button
    const btn = document.getElementById('runBacktestBtn');
    btn.disabled = true;

    // Show loading status
    showStatus('loading', `Backtesting en cours pour ${symbol} sur ${timeframe}...`);

    // Hide results
    document.getElementById('resultsSection').classList.remove('visible');

    try {
        const response = await fetch('/api/v1/backtest', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${getCookie('webui_auth_token')}`
            },
            body: JSON.stringify({
                symbol,
                timeframe,
                startDate,
                endDate,
                strategy: {
                    minConfidence,
                    minQualityScore: minQuality
                }
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Erreur lors du backtest');
        }

        const results = await response.json();
        currentResults = results;

        showStatus('success', `Backtest terminé: ${results.summary.trades_executed} trades exécutés`);
        displayResults(results);

    } catch (error) {
        console.error('Backtest error:', error);
        showStatus('error', `Erreur: ${error.message}`);
    } finally {
        btn.disabled = false;
    }
};

/**
 * Display backtest results
 */
function displayResults(results) {
    const { summary, performance, trades } = results;

    // Show results section
    document.getElementById('resultsSection').classList.add('visible');

    // Display summary cards
    displaySummary(summary, performance);

    // Display performance metrics
    displayPerformance(performance);

    // Display trades
    displayTrades(trades);
}

/**
 * Display summary cards
 */
function displaySummary(summary, performance) {
    const summaryGrid = document.getElementById('summaryGrid');

    const cards = [
        {
            label: 'Chandeliers Analysés',
            value: summary.candles_analyzed.toLocaleString(),
            class: ''
        },
        {
            label: 'Signaux Générés',
            value: summary.signals_generated.toLocaleString(),
            class: ''
        },
        {
            label: 'Trades Exécutés',
            value: summary.trades_executed.toLocaleString(),
            class: ''
        },
        {
            label: 'Win Rate',
            value: `${performance.win_rate.toFixed(1)}%`,
            class: performance.win_rate >= 60 ? 'positive' : performance.win_rate >= 40 ? '' : 'negative'
        },
        {
            label: 'P&L Total',
            value: `${performance.total_pnl_percent > 0 ? '+' : ''}${performance.total_pnl_percent.toFixed(2)}%`,
            class: performance.total_pnl_percent > 0 ? 'positive' : 'negative'
        },
        {
            label: 'vs Buy & Hold',
            value: `${performance.strategy_vs_hold > 0 ? '+' : ''}${performance.strategy_vs_hold.toFixed(2)}%`,
            class: performance.strategy_vs_hold > 0 ? 'positive' : 'negative'
        }
    ];

    summaryGrid.innerHTML = cards.map(card => `
        <div class="stat-card">
            <div class="stat-label">${card.label}</div>
            <div class="stat-value ${card.class}">${card.value}</div>
        </div>
    `).join('');
}

/**
 * Display performance metrics
 */
function displayPerformance(performance) {
    const section = document.getElementById('performanceSection');

    const metrics = [
        { label: 'Total Trades', value: performance.total_trades },
        { label: 'Trades Gagnants', value: performance.winning_trades, class: 'positive' },
        { label: 'Trades Perdants', value: performance.losing_trades, class: 'negative' },
        { label: 'Win Rate', value: `${performance.win_rate.toFixed(2)}%`, class: performance.win_rate >= 60 ? 'positive' : '' },
        { label: 'Profit Factor', value: performance.profit_factor.toFixed(2), class: performance.profit_factor >= 2 ? 'positive' : '' },
        { label: 'Sharpe Ratio', value: performance.sharpe_ratio.toFixed(2), class: performance.sharpe_ratio >= 1 ? 'positive' : '' },
        { label: 'Max Drawdown', value: `-${performance.max_drawdown.toFixed(2)}%`, class: 'negative' },
        { label: 'Gain Moyen', value: `${performance.average_win.toFixed(2)}`, class: 'positive' },
        { label: 'Perte Moyenne', value: `${performance.average_loss.toFixed(2)}`, class: 'negative' },
        { label: 'Buy & Hold P&L', value: `${performance.buy_and_hold_pnl_percent > 0 ? '+' : ''}${performance.buy_and_hold_pnl_percent.toFixed(2)}%` },
        { label: 'Stratégie P&L', value: `${performance.total_pnl_percent > 0 ? '+' : ''}${performance.total_pnl_percent.toFixed(2)}%`, class: performance.total_pnl_percent > 0 ? 'positive' : 'negative' },
        { label: 'Différence vs Hold', value: `${performance.strategy_vs_hold > 0 ? '+' : ''}${performance.strategy_vs_hold.toFixed(2)}%`, class: performance.strategy_vs_hold > 0 ? 'positive' : 'negative' }
    ];

    section.innerHTML = `
        <h2>📊 Métriques de Performance</h2>
        ${metrics.map(metric => `
            <div class="metric-row">
                <span class="metric-label">${metric.label}</span>
                <span class="metric-value ${metric.class || ''}">${metric.value}</span>
            </div>
        `).join('')}
    `;
}

/**
 * Display trades
 */
function displayTrades(trades) {
    const section = document.getElementById('tradesSection');

    if (trades.length === 0) {
        section.innerHTML = '<h2>📈 Trades</h2><p style="color: #aaa;">Aucun trade exécuté</p>';
        return;
    }

    // Show last 10 trades
    const recentTrades = trades.slice(-10).reverse();

    section.innerHTML = `
        <h2>📈 Derniers Trades (${recentTrades.length}/${trades.length})</h2>
        ${recentTrades.map(trade => `
            <div class="trade-card ${trade.result.toLowerCase()}">
                <div class="trade-header">
                    <span class="trade-direction">
                        ${trade.direction === 'LONG' ? '📈' : '📉'} ${trade.direction}
                    </span>
                    <span class="trade-pnl ${trade.pnl_percent > 0 ? 'positive' : 'negative'}">
                        ${trade.pnl_percent > 0 ? '+' : ''}${trade.pnl_percent.toFixed(2)}%
                    </span>
                </div>
                <div class="trade-details">
                    <div><span class="detail-label">Entrée:</span> ${new Date(trade.entry_time).toLocaleString()}</div>
                    <div><span class="detail-label">Prix entrée:</span> ${trade.entry_price.toFixed(2)}</div>
                    <div><span class="detail-label">Sortie:</span> ${new Date(trade.exit_time).toLocaleString()}</div>
                    <div><span class="detail-label">Prix sortie:</span> ${trade.exit_price.toFixed(2)}</div>
                    <div><span class="detail-label">Confiance:</span> ${(trade.confidence * 100).toFixed(0)}%</div>
                    <div><span class="detail-label">Raison:</span> ${trade.exit_reason}</div>
                </div>
            </div>
        `).join('')}
    `;
}

/**
 * Show status message
 */
function showStatus(type, message) {
    const statusDiv = document.getElementById('statusMessage');
    statusDiv.className = `status-message ${type}`;

    if (type === 'loading') {
        statusDiv.innerHTML = `<div class="spinner"></div><span>${message}</span>`;
    } else {
        statusDiv.textContent = message;
    }

    if (type !== 'loading') {
        setTimeout(() => {
            statusDiv.classList.remove(type);
            statusDiv.style.display = 'none';
        }, 5000);
    }
}

/**
 * Export results as JSON
 */
window.exportJSON = function() {
    if (!currentResults) {
        showStatus('error', 'Aucun résultat à exporter');
        return;
    }

    const dataStr = JSON.stringify(currentResults, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backtest_${currentResults.summary.symbol}_${new Date().toISOString()}.json`;
    a.click();
    URL.revokeObjectURL(url);

    showStatus('success', 'Résultats exportés en JSON');
};

/**
 * Export trades as CSV
 */
window.exportCSV = function() {
    if (!currentResults || !currentResults.trades) {
        showStatus('error', 'Aucun trade à exporter');
        return;
    }

    const headers = ['Entry Time', 'Exit Time', 'Direction', 'Entry Price', 'Exit Price', 'P&L', 'P&L %', 'Result', 'Exit Reason', 'Confidence'];
    const rows = currentResults.trades.map(trade => [
        new Date(trade.entry_time).toISOString(),
        new Date(trade.exit_time).toISOString(),
        trade.direction,
        trade.entry_price,
        trade.exit_price,
        trade.pnl,
        trade.pnl_percent,
        trade.result,
        trade.exit_reason,
        trade.confidence
    ]);

    const csv = [headers, ...rows].map(row => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backtest_trades_${currentResults.summary.symbol}_${new Date().toISOString()}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    showStatus('success', 'Trades exportés en CSV');
};

/**
 * Logout
 */
window.logout = function() {
    document.cookie = 'webui_auth_token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
    window.location.href = '/login.html';
};

/**
 * Get cookie value
 */
function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
    return '';
}
