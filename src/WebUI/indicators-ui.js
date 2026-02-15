/* exported buildIndicatorUI */
// Build indicator UI dynamically from catalog
async function buildIndicatorUI() {
    try {
        const catalog = await fetchCatalog();
        catalogData = catalog;

        const indicatorListEl = document.getElementById('indicatorList');
        indicatorListEl.innerHTML = ''; // Clear existing

        // Category display names
        const categoryNames = {
            movingAverages: 'Moyennes Mobiles',
            momentum: 'Momentum',
            volatility: 'Volatilité',
            trend: 'Tendance',
            volume: 'Volume',
            supportResistance: 'Support/Résistance',
            advanced: 'Avancé',
        };

        // Count total indicators
        let totalIndicators = 0;
        for (const [_category, data] of Object.entries(catalog))
            if (data.indicators && Array.isArray(data.indicators))
                totalIndicators += data.indicators.length;

        // Update stats
        document.getElementById('totalCount').textContent = totalIndicators;

        // Build UI for each category as accordion
        for (const [category, data] of Object.entries(catalog)) {
            if (!data.indicators || !Array.isArray(data.indicators)) continue;

            // Create category section
            const categorySection = document.createElement('div');
            categorySection.className = 'indicator-category';

            // Create category header (clickable to expand/collapse)
            const header = document.createElement('div');
            header.className = 'category-header';

            const categoryName = document.createElement('span');
            categoryName.className = 'category-name';
            categoryName.textContent = `${categoryNames[category] || category} (${data.indicators.length})`;

            const arrow = document.createElement('span');
            arrow.className = 'category-arrow';
            arrow.textContent = '▸';

            header.appendChild(categoryName);
            header.appendChild(arrow);
            categorySection.appendChild(header);

            // Create items container (collapsed by default)
            const itemsContainer = document.createElement('div');
            itemsContainer.className = 'category-items';

            // Add indicators for this category
            data.indicators.forEach(indicator => {
                const indicatorItem = document.createElement('div');
                indicatorItem.className = 'indicator-item';

                // Handle both old format (string) and new format (object)
                const indicatorKey = typeof indicator === 'string' ? indicator : indicator.key;
                const indicatorDesc = typeof indicator === 'string' ? indicator.toUpperCase() : indicator.description;
                const indicatorWarmup = typeof indicator === 'object' ? indicator.warmup : null;

                // Store the description and warmup in the global map
                if (typeof indicator === 'object') {
                    const displayText = indicatorWarmup
                        ? `${indicatorDesc} (${indicatorWarmup})`
                        : indicatorDesc;
                    indicatorDescriptions.set(indicatorKey, displayText);
                }

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = `ind-${indicatorKey}`;
                checkbox.value = indicatorKey;
                checkbox.dataset.category = category;

                const label = document.createElement('label');
                label.htmlFor = `ind-${indicatorKey}`;
                label.textContent = indicatorWarmup
                    ? `${indicatorDesc} (${indicatorWarmup})`
                    : indicatorDesc;

                indicatorItem.appendChild(checkbox);
                indicatorItem.appendChild(label);
                itemsContainer.appendChild(indicatorItem);
            });

            categorySection.appendChild(itemsContainer);
            indicatorListEl.appendChild(categorySection);

            // Add click handler to toggle accordion
            header.addEventListener('click', () => {
                const isOpen = header.classList.contains('open');
                if (isOpen) {
                    header.classList.remove('open');
                    itemsContainer.classList.remove('open');
                } else {
                    header.classList.add('open');
                    itemsContainer.classList.add('open');
                }
            });
        }

        // Attach event listeners to all checkboxes
        attachIndicatorListeners();

        // Setup clear all button
        setupClearAllButton();

        // Setup sidebar toggle
        setupSidebarToggle();

        // Setup search functionality
        setupIndicatorSearch();

        console.log('Indicator UI built successfully with', Object.keys(catalog).length, 'categories');
    } catch (error) {
        console.error('Failed to build indicator UI:', error);
        showStatus(`Erreur lors du chargement du catalogue: ${error.message}`, 'error');
    }
}

function setupSidebarToggle() {
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebarToggle');

    toggleBtn.addEventListener('click', () => {
        const isCollapsed = sidebar.classList.contains('collapsed');
        if (isCollapsed) {
            // Open sidebar
            sidebar.classList.remove('collapsed');
            toggleBtn.classList.remove('sidebar-closed');
            toggleBtn.textContent = '‹';
        } else {
            // Close sidebar
            sidebar.classList.add('collapsed');
            toggleBtn.classList.add('sidebar-closed');
            toggleBtn.textContent = '›';
        }

        // Resize charts after sidebar animation completes
        setTimeout(() => {
            if (typeof resizeCharts === 'function') 
                resizeCharts();
            
        }, 350); // Wait for sidebar transition (300ms) + a bit more
    });
}

function attachIndicatorListeners() {
    document.querySelectorAll('#indicatorList input[type="checkbox"]').forEach(checkbox => {
        checkbox.addEventListener('change', async (e) => {
            if (!currentData) {
                showStatus('Veuillez d\'abord charger les données OHLCV', 'error');
                e.target.checked = false;
                setTimeout(hideStatus, 3000);
                return;
            }

            const indicator = e.target.value;
            const symbol = document.getElementById('symbol').value.trim().toUpperCase();
            const timeframe = document.getElementById('timeframe').value;
            const bars = parseInt(document.getElementById('bars').value);

            if (e.target.checked) {
                await addIndicator(indicator, symbol, timeframe, bars);
                // Add to selected indicators section
                addToSelectedIndicators(indicator);
            } else {
                removeIndicator(indicator);
                // Remove from selected indicators section
                removeFromSelectedIndicators(indicator);
            }

            // Update stats
            updateIndicatorStats();
            updateSelectedIndicatorsVisibility();
        });
    });
}

function updateIndicatorStats() {
    const selectedCount = document.querySelectorAll('#indicatorList input[type="checkbox"]:checked').length;
    document.getElementById('selectedCount').textContent = selectedCount;

    // Show/hide clear all button
    const clearBtn = document.getElementById('clearAllBtn');
    if (selectedCount > 0) 
        clearBtn.style.display = 'block';
     else 
        clearBtn.style.display = 'none';
    
}

function setupClearAllButton() {
    const clearBtn = document.getElementById('clearAllBtn');
    clearBtn.addEventListener('click', () => {
        // Uncheck all checkboxes
        document.querySelectorAll('#indicatorList input[type="checkbox"]:checked').forEach(checkbox => {
            checkbox.checked = false;
            removeIndicator(checkbox.value);
            removeFromSelectedIndicators(checkbox.value);
        });
        updateIndicatorStats();
        updateSelectedIndicatorsVisibility();
    });
}

function removeIndicator(name) {
    // Remove all series related to this indicator
    const keysToRemove = Array.from(indicatorSeries.keys()).filter(k => k.startsWith(name));
    keysToRemove.forEach(key => {
        const series = indicatorSeries.get(key);
        if (key.includes('overlay')) 
            mainChart.removeSeries(series);
         else if (key.includes('oscillator')) 
            indicatorChart.removeSeries(series);
        
        indicatorSeries.delete(key);
    });

    // Hide oscillator chart if no oscillators remain
    const hasOscillators = Array.from(indicatorSeries.keys()).some(k => k.includes('oscillator'));
    if (!hasOscillators) 
        document.getElementById('indicatorChartWrapper').style.display = 'none';

    // Update oscillator title
    const oscillatorNames = Array.from(indicatorSeries.keys())
        .filter(k => k.includes('oscillator'))
        .map(k => k.split('-')[0].toUpperCase())
        .filter((v, i, a) => a.indexOf(v) === i); // unique

    document.getElementById('indicatorTitle').textContent = oscillatorNames.length > 0
        ? `Indicateurs: ${oscillatorNames.join(', ')}`
        : 'Indicateurs';
}

function setupIndicatorSearch() {
    const searchInput = document.getElementById('indicatorSearch');

    searchInput.addEventListener('input', (e) => {
        const searchTerm = e.target.value.toLowerCase().trim();

        // Get all categories
        const categories = document.querySelectorAll('.indicator-category');

        categories.forEach(category => {
            const categoryHeader = category.querySelector('.category-header');
            const categoryItems = category.querySelector('.category-items');
            const items = category.querySelectorAll('.indicator-item');

            let hasVisibleItems = false;

            // Filter items
            items.forEach(item => {
                const label = item.querySelector('label');
                const indicatorName = label.textContent.toLowerCase();

                if (searchTerm === '' || indicatorName.includes(searchTerm)) {
                    item.style.display = 'flex';
                    hasVisibleItems = true;
                } else {
                    item.style.display = 'none';
                }
            });

            // Show/hide category based on visible items
            if (hasVisibleItems) {
                category.style.display = 'block';

                // Auto-open category if search is active
                if (searchTerm !== '') {
                    categoryHeader.classList.add('open');
                    categoryItems.classList.add('open');
                } else {
                    // Close category when search is cleared
                    categoryHeader.classList.remove('open');
                    categoryItems.classList.remove('open');
                }
            } else {
                category.style.display = 'none';
            }
        });
    });
}

// ========== Selected Indicators Section Management ==========

// Track indicator visibility and colors
const indicatorSettings = new Map(); // key: indicatorName, value: { visible, color }

function updateSelectedIndicatorsVisibility() {
    const section = document.getElementById('selectedIndicatorsSection');
    const selectedCount = document.querySelectorAll('#indicatorList input[type="checkbox"]:checked').length;

    if (selectedCount > 0) 
        section.style.display = 'block';
     else 
        section.style.display = 'none';
    
}

function addToSelectedIndicators(indicatorName) {
    const list = document.getElementById('selectedIndicatorsList');

    // Get initial color from first series
    let initialColor = '#2196F3';
    const firstSeriesKey = Array.from(indicatorSeries.keys()).find(key => key.startsWith(indicatorName));
    if (firstSeriesKey) {
        const series = indicatorSeries.get(firstSeriesKey);
        if (series && series.options && series.options().color) 
            initialColor = series.options().color;
        
    }

    // Store settings
    indicatorSettings.set(indicatorName, { visible: true, color: initialColor });

    // Create item
    const item = document.createElement('div');
    item.className = 'selected-indicator-item';
    item.id = `selected-${indicatorName}`;

    // Color box (clickable)
    const colorBox = document.createElement('div');
    colorBox.className = 'selected-indicator-color';
    colorBox.style.backgroundColor = initialColor;
    colorBox.title = 'Changer la couleur';
    colorBox.addEventListener('click', () => showSelectedColorPicker(indicatorName, colorBox));

    // Name
    const name = document.createElement('div');
    name.className = 'selected-indicator-name';
    name.textContent = indicatorDescriptions.get(indicatorName) || indicatorName.toUpperCase();

    // Controls
    const controls = document.createElement('div');
    controls.className = 'selected-indicator-controls';

    // Visibility button
    const visibilityBtn = document.createElement('button');
    visibilityBtn.className = 'selected-indicator-btn';
    visibilityBtn.innerHTML = '👁';
    visibilityBtn.title = 'Masquer/Afficher';
    visibilityBtn.dataset.indicator = indicatorName;
    visibilityBtn.addEventListener('click', () => toggleSelectedIndicatorVisibility(indicatorName, visibilityBtn));

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'selected-indicator-btn delete';
    deleteBtn.innerHTML = '✕';
    deleteBtn.title = 'Supprimer';
    deleteBtn.dataset.indicator = indicatorName;
    deleteBtn.addEventListener('click', () => deleteSelectedIndicator(indicatorName));

    controls.appendChild(visibilityBtn);
    controls.appendChild(deleteBtn);

    item.appendChild(colorBox);
    item.appendChild(name);
    item.appendChild(controls);

    list.appendChild(item);
}

function removeFromSelectedIndicators(indicatorName) {
    const item = document.getElementById(`selected-${indicatorName}`);
    if (item) 
        item.remove();
    
    indicatorSettings.delete(indicatorName);
}

function toggleSelectedIndicatorVisibility(indicatorName, btn) {
    const settings = indicatorSettings.get(indicatorName);
    if (!settings) return;

    const newVisibility = !settings.visible;
    settings.visible = newVisibility;
    indicatorSettings.set(indicatorName, settings);

    // Update all series for this indicator
    Array.from(indicatorSeries.keys())
        .filter(key => key.startsWith(indicatorName))
        .forEach(key => {
            const series = indicatorSeries.get(key);
            if (series && series.applyOptions) 
                series.applyOptions({ visible: newVisibility });
            
        });

    // Update button
    btn.innerHTML = newVisibility ? '👁' : '👁‍🗨';
    btn.classList.toggle('hidden-indicator', !newVisibility);
}

function deleteSelectedIndicator(indicatorName) {
    // Uncheck the checkbox
    const checkbox = document.getElementById(`ind-${indicatorName}`);
    if (checkbox) 
        checkbox.checked = false;

    // Remove the indicator
    removeIndicator(indicatorName);
    removeFromSelectedIndicators(indicatorName);

    // Update stats
    updateIndicatorStats();
    updateSelectedIndicatorsVisibility();
}

function showSelectedColorPicker(indicatorName, colorBox) {
    const colors = ['#2196F3', '#FF9800', '#9C27B0', '#4CAF50', '#F44336', '#00BCD4', '#FF5722', '#FFEB3B', '#E91E63'];

    // Create picker
    const picker = document.createElement('div');
    picker.className = 'color-picker-popup';
    picker.style.position = 'fixed';
    picker.style.zIndex = '1000';
    picker.style.background = '#2a2a2a';
    picker.style.border = '1px solid #444';
    picker.style.borderRadius = '4px';
    picker.style.padding = '8px';
    picker.style.display = 'grid';
    picker.style.gridTemplateColumns = 'repeat(3, 1fr)';
    picker.style.gap = '6px';
    picker.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.5)';

    // Position near the color box
    const rect = colorBox.getBoundingClientRect();
    picker.style.top = `${rect.bottom + 5}px`;
    picker.style.left = `${rect.left}px`;

    // Add color options
    colors.forEach(color => {
        const option = document.createElement('div');
        option.style.width = '24px';
        option.style.height = '24px';
        option.style.backgroundColor = color;
        option.style.borderRadius = '3px';
        option.style.cursor = 'pointer';
        option.style.border = '2px solid transparent';
        option.style.transition = 'all 0.2s';

        option.addEventListener('mouseenter', () => {
            option.style.borderColor = '#fff';
            option.style.transform = 'scale(1.1)';
        });

        option.addEventListener('mouseleave', () => {
            option.style.borderColor = 'transparent';
            option.style.transform = 'scale(1)';
        });

        option.addEventListener('click', () => {
            // Update settings
            const settings = indicatorSettings.get(indicatorName);
            if (settings) {
                settings.color = color;
                indicatorSettings.set(indicatorName, settings);
            }

            // Update color box
            colorBox.style.backgroundColor = color;

            // Update all series
            Array.from(indicatorSeries.keys())
                .filter(key => key.startsWith(indicatorName))
                .forEach(key => {
                    const series = indicatorSeries.get(key);
                    if (series && series.applyOptions && !key.includes('ref') && !key.includes('histogram')) 
                        series.applyOptions({ color: color });
                    
                });

            // Close picker
            document.body.removeChild(picker);
        });

        picker.appendChild(option);
    });

    // Close on outside click
    const closeHandler = (e) => {
        if (!picker.contains(e.target) && e.target !== colorBox) {
            if (document.body.contains(picker)) 
                document.body.removeChild(picker);
            
            document.removeEventListener('click', closeHandler);
        }
    };

    setTimeout(() => document.addEventListener('click', closeHandler), 0);
    document.body.appendChild(picker);
}
