/**
 * Cache Manager UI
 * Manages the cache tab: fetch stats, display table, delete entries
 */

document.addEventListener('DOMContentLoaded', () => {
	const refreshBtn = document.getElementById('cacheRefreshBtn');
	const clearAllBtn = document.getElementById('cacheClearAllBtn');
	const tableBody = document.getElementById('cacheTableBody');
	const statsSummary = document.getElementById('cacheStatsSummary');
	const statusEl = document.getElementById('cacheStatus');
	const heatmapGrid = document.getElementById('cacheHeatmapGrid');

	function showStatus(message, type = 'info') {
		statusEl.textContent = message;
		statusEl.className = `status ${type}`;
		setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'status'; }, 3000);
	}

	function formatDate(isoString) {
		if (!isoString) return '-';
		const d = new Date(isoString);
		return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' })
			+ ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
	}

	function formatAge(seconds) {
		if (!seconds && seconds !== 0) return '-';
		if (seconds < 60) return `${seconds}s`;
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
		if (seconds < 86400) {
			const h = Math.floor(seconds / 3600);
			const m = Math.floor((seconds % 3600) / 60);
			return m > 0 ? `${h}h ${m}m` : `${h}h`;
		}
		const d = Math.floor(seconds / 86400);
		const h = Math.floor((seconds % 86400) / 3600);
		return h > 0 ? `${d}j ${h}h` : `${d}j`;
	}

	function formatTTL(seconds) {
		if (!seconds || seconds <= 0) return '∞';
		return formatAge(seconds);
	}

	function parseKey(key) {
		const parts = key.split(':');
		if (parts.length >= 2)
			return { symbol: parts[0], timeframe: parts[1] };
		return { symbol: key, timeframe: '-' };
	}

	function renderStats(data) {
		const hitRate = data.stats?.hitRate || '0%';
		statsSummary.innerHTML = `
			<div class="cache-stat">
				<span class="cache-stat-value">${data.entryCount}</span>
				<span class="cache-stat-label">Entrees</span>
			</div>
			<div class="cache-stat">
				<span class="cache-stat-value">${data.totalBars.toLocaleString('fr-FR')}</span>
				<span class="cache-stat-label">Barres</span>
			</div>
			<div class="cache-stat">
				<span class="cache-stat-value">${hitRate}</span>
				<span class="cache-stat-label">Hit Rate</span>
			</div>
			<div class="cache-stat">
				<span class="cache-stat-value">${data.stats?.hits || 0}</span>
				<span class="cache-stat-label">Hits</span>
			</div>
			<div class="cache-stat">
				<span class="cache-stat-value">${data.stats?.misses || 0}</span>
				<span class="cache-stat-label">Misses</span>
			</div>
		`;
	}

	function renderTable(entries) {
		if (!entries || entries.length === 0) {
			tableBody.innerHTML = '<tr><td colspan="8" class="cache-empty">Cache vide</td></tr>';
			return;
		}

		// Sort by symbol, then timeframe
		entries.sort((a, b) => a.key.localeCompare(b.key));

		tableBody.innerHTML = entries.map(entry => {
			const { symbol, timeframe } = parseKey(entry.key);
			return `<tr>
				<td class="text-mono">${symbol}</td>
				<td class="text-mono">${timeframe}</td>
				<td>${entry.count.toLocaleString('fr-FR')}</td>
				<td>${formatDate(entry.start)}</td>
				<td>${formatDate(entry.end)}</td>
				<td>${formatAge(entry.age)}</td>
				<td>${formatTTL(entry.ttlRemaining)}</td>
				<td><button class="btn-delete-entry" data-symbol="${symbol}" data-timeframe="${timeframe}">Supprimer</button></td>
			</tr>`;
		}).join('');

		// Attach delete handlers
		tableBody.querySelectorAll('.btn-delete-entry').forEach(btn => {
			btn.addEventListener('click', () => {
				const sym = btn.dataset.symbol;
				const tf = btn.dataset.timeframe;
				deleteEntry(sym, tf);
			});
		});
	}

	// Timeframe ordering for heatmap columns
	const TF_ORDER = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w', '1M'];

	function getHeatmapColor(count, maxCount) {
		if (!count) return null; // empty cell
		const ratio = Math.min(count / maxCount, 1);
		// Blue (few bars) → Cyan → Yellow → Orange (many bars)
		if (ratio < 0.33) {
			const t = ratio / 0.33;
			const r = Math.round(20 + t * 0);
			const g = Math.round(60 + t * 140);
			const b = Math.round(180 - t * 30);
			return `rgb(${r}, ${g}, ${b})`;
		} else if (ratio < 0.66) {
			const t = (ratio - 0.33) / 0.33;
			const r = Math.round(20 + t * 210);
			const g = Math.round(200 - t * 20);
			const b = Math.round(150 - t * 120);
			return `rgb(${r}, ${g}, ${b})`;
		} else {
			const t = (ratio - 0.66) / 0.34;
			const r = Math.round(230 + t * 25);
			const g = Math.round(180 - t * 100);
			const b = Math.round(30 - t * 20);
			return `rgb(${r}, ${g}, ${b})`;
		}
	}

	function renderHeatmap(entries) {
		if (!entries || entries.length === 0) {
			heatmapGrid.innerHTML = '<div class="heatmap-no-data">Aucune entree en cache</div>';
			return;
		}

		// Build lookup: { symbol: { timeframe: entry } }
		const lookup = {};
		const symbolSet = new Set();
		const tfSet = new Set();
		let maxCount = 0;

		for (const entry of entries) {
			const { symbol, timeframe } = parseKey(entry.key);
			symbolSet.add(symbol);
			tfSet.add(timeframe);
			if (!lookup[symbol]) lookup[symbol] = {};
			lookup[symbol][timeframe] = entry;
			if (entry.count > maxCount) maxCount = entry.count;
		}

		// Sort symbols alphabetically, timeframes by duration
		const symbols = [...symbolSet].sort();
		const timeframes = [...tfSet].sort((a, b) => {
			const ia = TF_ORDER.indexOf(a);
			const ib = TF_ORDER.indexOf(b);
			return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
		});

		heatmapGrid.className = 'heatmap-grid';
		heatmapGrid.style.gridTemplateColumns = `auto repeat(${timeframes.length}, 1fr)`;

		let html = '';

		// Header row: empty corner + timeframe labels
		html += '<div class="heatmap-header"></div>';
		for (const tf of timeframes)
			html += `<div class="heatmap-header">${tf}</div>`;

		// Data rows
		for (const sym of symbols) {
			html += `<div class="heatmap-row-label">${sym}</div>`;
			for (const tf of timeframes) {
				const entry = lookup[sym]?.[tf];
				if (entry) {
					const color = getHeatmapColor(entry.count, maxCount);
					const textColor = entry.count / maxCount > 0.5 ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.8)';
					html += `<div class="heatmap-cell" style="background:${color};color:${textColor}">
						${entry.count.toLocaleString('fr-FR')}
						<div class="heatmap-tooltip">
							<div class="heatmap-tooltip-row"><span class="heatmap-tooltip-label">Symbol</span><span>${sym}:${tf}</span></div>
							<div class="heatmap-tooltip-row"><span class="heatmap-tooltip-label">Barres</span><span>${entry.count.toLocaleString('fr-FR')}</span></div>
							<div class="heatmap-tooltip-row"><span class="heatmap-tooltip-label">Age</span><span>${formatAge(entry.age)}</span></div>
							<div class="heatmap-tooltip-row"><span class="heatmap-tooltip-label">TTL</span><span>${formatTTL(entry.ttlRemaining)}</span></div>
							<div class="heatmap-tooltip-row"><span class="heatmap-tooltip-label">Debut</span><span>${formatDate(entry.start)}</span></div>
							<div class="heatmap-tooltip-row"><span class="heatmap-tooltip-label">Fin</span><span>${formatDate(entry.end)}</span></div>
						</div>
					</div>`;
				} else {
					html += '<div class="heatmap-cell heatmap-empty">-</div>';
				}
			}
		}

		heatmapGrid.innerHTML = html;
	}

	async function fetchCacheStats() {
		try {
			const response = await fetch('/api/v1/cache/stats');
			const result = await response.json();

			if (!result.success) {
				showStatus(result.error?.message || 'Erreur lors du chargement', 'error');
				return;
			}

			const cache = result.data.cache;
			renderStats(cache);
			renderHeatmap(cache.entries);
			renderTable(cache.entries);
		} catch (error) {
			showStatus(`Erreur: ${error.message}`, 'error');
			tableBody.innerHTML = '<tr><td colspan="8" class="cache-empty">Erreur de connexion au serveur</td></tr>';
		}
	}

	async function deleteEntry(symbol, timeframe) {
		if (!confirm(`Supprimer le cache pour ${symbol}:${timeframe} ?`))
			return;

		try {
			const params = new URLSearchParams({ symbol, timeframe });
			const response = await fetch(`/api/v1/cache/clear?${params}`, { method: 'DELETE' });
			const result = await response.json();

			if (result.success) {
				showStatus(`Cache ${symbol}:${timeframe} supprime`, 'success');
				fetchCacheStats();
			} else {
				showStatus(result.error?.message || 'Erreur', 'error');
			}
		} catch (error) {
			showStatus(`Erreur: ${error.message}`, 'error');
		}
	}

	async function clearAll() {
		if (!confirm('Vider tout le cache ? Cette action est irreversible.'))
			return;

		try {
			const response = await fetch('/api/v1/cache/clear', { method: 'DELETE' });
			const result = await response.json();

			if (result.success) {
				showStatus(`${result.data?.cleared || 0} entree(s) supprimee(s)`, 'success');
				fetchCacheStats();
			} else {
				showStatus(result.error?.message || 'Erreur', 'error');
			}
		} catch (error) {
			showStatus(`Erreur: ${error.message}`, 'error');
		}
	}

	// Event listeners
	refreshBtn.addEventListener('click', fetchCacheStats);
	clearAllBtn.addEventListener('click', clearAll);

	// Auto-refresh when cache tab becomes active
	document.querySelectorAll('.tab-btn').forEach(btn => {
		btn.addEventListener('click', () => {
			if (btn.dataset.tab === 'cache')
				fetchCacheStats();
		});
	});

	// Load if cache tab is active on page load
	const savedTab = localStorage.getItem('activeTab');
	if (savedTab === 'cache')
		fetchCacheStats();
});
