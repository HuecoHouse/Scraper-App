// public/script.js
document.addEventListener('DOMContentLoaded', () => {
  const termInput = document.getElementById('search-term');
  const pctInput = document.getElementById('percentage');
  const sourceCheckboxes = document.querySelectorAll('input[name="source"]');
  const scanBtn = document.getElementById('scan-btn');
  const resultsDiv = document.getElementById('results');
  const statusDiv = document.getElementById('status');

  function getSelectedSources() {
    return Array.from(sourceCheckboxes)
      .filter(cb => cb.checked)
      .map(cb => cb.value);
  }

  async function manualScan() {
    const term = termInput.value.trim();
    const percentage = Number(pctInput.value) || 40;
    const sources = getSelectedSources();

    resultsDiv.innerHTML = '';
    statusDiv.textContent = `SCANNING "${term}" — ${percentage}% — sources: ${sources.join(', ')}`;
    statusDiv.classList.add('scanning');

    try {
      const resp = await fetch('/manual-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ term, percentage, sources })
      });

      const json = await resp.json();

      if (!json.success) {
        resultsDiv.innerHTML = `<div class="error">Scan failed: ${json.error || 'Unknown'}</div>`;
        return;
      }

      if (!json.deals || json.deals.length === 0) {
        resultsDiv.innerHTML = `<div class="empty">No deals found (scanned ${json.scanned} items).</div>`;
        return;
      }

      const frag = document.createDocumentFragment();
      json.deals.forEach(deal => {
        const card = document.createElement('div');
        card.className = 'deal-card';
        card.innerHTML = `
          <div class="deal-title">${deal.title || 'Untitled'}</div>
          <div class="deal-meta">
            Source: ${deal.source} • Price: $${deal.price.toFixed(2)} • ${deal.pctBelowMarket}% below market ($${deal.marketPrice})
          </div>
          <div><a href="${deal.link}" target="_blank">Open Listing</a></div>
        `;
        frag.appendChild(card);
      });
      resultsDiv.appendChild(frag);

    } catch (err) {
      resultsDiv.innerHTML = `<div class="error">Network error: ${err.message}</div>`;
    } finally {
      statusDiv.classList.remove('scanning');
      statusDiv.textContent = 'Scan complete';
    }
  }

  scanBtn.addEventListener('click', (e) => {
    e.preventDefault();
    manualScan();
  });
});
