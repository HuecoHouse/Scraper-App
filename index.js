// index.js (replace your existing server file with this or merge accordingly)
import express from 'express';
import axios from 'axios';
import cheerio from 'cheerio';
import pkg from 'https-proxy-agent';
const { HttpsProxyAgent } = pkg;
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// HARD-CODED PUBLIC PROXIES (replace with working ones)
const proxies = [
  'http://51.158.123.35:8811',
  'http://185.62.189.54:8060',
  'http://163.172.182.164:8811'
];

function pickProxy() {
  const proxy = proxies[Math.floor(Math.random() * proxies.length)];
  console.log(`[PROXY] Using proxy: ${proxy}`);
  return proxy;
}

async function axiosGetWithProxy(url, options = {}) {
  // pick proxy and build agent
  const proxyUrl = pickProxy();
  let axiosConfig = { timeout: 20000, ...options };

  try {
    const agent = new HttpsProxyAgent(proxyUrl);
    axiosConfig.httpsAgent = agent;
    axiosConfig.httpAgent = agent;
    // disable axios proxy setting, because we use agent
    axiosConfig.proxy = false;
    const res = await axios.get(url, axiosConfig);
    return res;
  } catch (err) {
    console.error(`[PROXY ERROR] ${err.message} for ${url}`);
    throw err;
  }
}

/**
 * Scrape TCGplayer (market price reference) - conservative approach.
 * Returns number (marketPrice) or null if failed.
 */
async function scrapeTCGplayer(term) {
  const encoded = encodeURIComponent(term);
  const searchUrl = `https://www.tcgplayer.com/search/all/product?q=${encoded}`;
  try {
    console.log(`[TCGPLAYER] Searching TCGplayer for "${term}"`);
    const res = await axiosGetWithProxy(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }});
    const $ = cheerio.load(res.data);
    // Note: selectors on TCGplayer change — try a few fallbacks
    // Try to find the first product link and then fetch its price summary
    const firstLink = $('a.search-result__title').attr('href') || $('a.ProductCard__link').attr('href');
    if (!firstLink) {
      console.warn('[TCGPLAYER] No product link found on search page');
      return null;
    }
    const productUrl = firstLink.startsWith('http') ? firstLink : `https://www.tcgplayer.com${firstLink}`;
    console.log(`[TCGPLAYER] Found product URL: ${productUrl}`);
    const productRes = await axiosGetWithProxy(productUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }});
    const $$ = cheerio.load(productRes.data);

    // Try multiple selectors for price
    let marketPriceText = $$('span.price--market').first().text() ||
                          $$('span.marketPrice').first().text() ||
                          $$('meta[itemprop="price"]').attr('content') ||
                          $$('div.product-market-price').text();

    if (!marketPriceText) {
      // Try to parse from JSON LD or scripts (best effort)
      const scriptTxt = $$('script[type="application/ld+json"]').html() || '';
      const matches = scriptTxt.match(/"price":\s*"([\d\.]+)"/);
      if (matches) marketPriceText = matches[1];
    }

    if (!marketPriceText) {
      console.warn('[TCGPLAYER] Could not find market price on product page');
      return null;
    }

    // clean up price text
    const cleaned = marketPriceText.replace(/[^0-9.]/g, '');
    const marketPrice = parseFloat(cleaned);
    console.log(`[TCGPLAYER] Market Price for "${term}": ${marketPrice}`);
    return isNaN(marketPrice) ? null : marketPrice;
  } catch (err) {
    console.error(`[TCGPLAYER ERROR] ${err.message}`);
    return null;
  }
}

/**
 * Scrape eBay search results - returns array of {title, price, link}
 */
async function scrapeEbay(term) {
  const encoded = encodeURIComponent(term);
  const searchUrl = `https://www.ebay.com/sch/i.html?_nkw=${encoded}`;
  try {
    console.log(`[EBAY] Searching eBay for "${term}"`);
    const res = await axiosGetWithProxy(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }});
    const $ = cheerio.load(res.data);
    const results = [];

    $('li.s-item').each((i, el) => {
      const title = $(el).find('h3.s-item__title').text().trim();
      const priceText = $(el).find('.s-item__price').first().text();
      const link = $(el).find('a.s-item__link').attr('href');
      if (!title || !priceText) return;
      const cleaned = priceText.replace(/[^0-9.]/g, '');
      const price = parseFloat(cleaned);
      if (!isNaN(price)) {
        results.push({ title, price, link, source: 'eBay' });
      }
    });

    console.log(`[EBAY] Found ${results.length} eBay results`);
    return results;
  } catch (err) {
    console.error(`[EBAY ERROR] ${err.message}`);
    return [];
  }
}

/**
 * Stubs for other retailers (Walmart/Target/Amazon)
 * For now they return empty arrays (or you can implement more scraping later)
 */
async function scrapeAmazon(term) {
  // Amazon aggressively blocks scrapers; implement carefully (or use product API)
  console.log('[AMAZON] Amazon scraping not fully implemented (stub)');
  return [];
}
async function scrapeWalmart(term) { console.log('[WALMART] Stub'); return []; }
async function scrapeTarget(term) { console.log('[TARGET] Stub'); return []; }

/**
 * Normalize and filter results against marketPrice and percentage (0..100)
 */
function filterDeals(allResults, marketPrice, percentage) {
  if (!marketPrice || marketPrice <= 0) {
    console.warn('[FILTER] No valid marketPrice provided — returning all results for debugging');
    return allResults;
  }
  const ratio = percentage / 100.0;
  const threshold = marketPrice * ratio;
  const filtered = allResults.filter(r => r.price && r.price < threshold);
  return filtered.map(r => ({
    ...r,
    marketPrice,
    pctBelowMarket: Math.round(((marketPrice - r.price) / marketPrice) * 100)
  }));
}

// Manual scan endpoint
app.post('/manual-scan', async (req, res) => {
  const { term = '', percentage = 40, sources = ['tcgplayer','ebay'] } = req.body;
  console.log(`[SCRAPER] Starting manual scan for "${term}" | pct: ${percentage}% | sources: ${sources.join(',')}`);

  const stats = { fetched: 0, errors: [] };
  try {
    // 1) Get marketPrice from TCGplayer (always try it first if selected or if used as reference)
    let marketPrice = null;
    if (sources.includes('tcgplayer') || true) {
      marketPrice = await scrapeTCGplayer(term);
    }

    // 2) Kick off scrapers for requested sources
    const promises = [];
    if (sources.includes('ebay')) promises.push(scrapeEbay(term));
    if (sources.includes('amazon')) promises.push(scrapeAmazon(term));
    if (sources.includes('walmart')) promises.push(scrapeWalmart(term));
    if (sources.includes('target')) promises.push(scrapeTarget(term));

    const settled = await Promise.allSettled(promises.map(p => (async () => {
      // small delay to avoid simultaneous hits, rotate proxies
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
      return await p;
    })()));

    // collect results
    let allResults = [];
    settled.forEach((s, idx) => {
      if (s.status === 'fulfilled') {
        const arr = s.value || [];
        stats.fetched += arr.length;
        allResults = allResults.concat(arr);
        console.log(`[SCRAPER] Source ${idx} returned ${arr.length} items`);
      } else {
        console.error(`[SCRAPER] Source ${idx} failed: ${s.reason && s.reason.message ? s.reason.message : s.reason}`);
        stats.errors.push(s.reason && s.reason.message ? s.reason.message : String(s.reason));
      }
    });

    // 3) filter results by marketPrice and percentage
    const deals = filterDeals(allResults, marketPrice, Number(percentage));
    console.log(`[SUMMARY] Scanned: ${allResults.length} items | Deals below ${percentage}%: ${deals.length}`);
    console.log(`[SUMMARY] lowest deal: ${deals.length ? JSON.stringify(deals[0]) : 'n/a'}`);

    res.json({ success: true, term, marketPrice, scanned: allResults.length, deals, stats });
  } catch (err) {
    console.error(`[SCAN ERROR] ${err.message}`);
    res.status(500).json({ success: false, error: err.message, stats });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Scraper-App running on port ${PORT}`);
});
