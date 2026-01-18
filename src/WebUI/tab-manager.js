/**
 * Tab Manager
 * Manages tab switching in the UI
 */

document.addEventListener('DOMContentLoaded', () => {
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabContents = {
        charts: document.getElementById('chartsTab')
    };

    // Function to switch tabs
    function switchTab(tabName) {
        // Update tab buttons
        tabButtons.forEach(btn => {
            if (btn.dataset.tab === tabName) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });

        // Update tab content
        Object.keys(tabContents).forEach(key => {
            if (tabContents[key]) {
                if (key === tabName) {
                    tabContents[key].classList.add('active');
                } else {
                    tabContents[key].classList.remove('active');
                }
            }
        });

        // Save active tab to localStorage
        localStorage.setItem('activeTab', tabName);
    }

    // Add click listeners to tab buttons
    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabName = btn.dataset.tab;
            switchTab(tabName);
        });
    });

    // Restore last active tab from localStorage or default to charts
    const savedTab = localStorage.getItem('activeTab');
    if (savedTab && tabContents[savedTab]) {
        switchTab(savedTab);
    } else {
        switchTab('charts');
    }
});
