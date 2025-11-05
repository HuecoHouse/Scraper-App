// index.js — fully corrected version
import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import pkg from 'https-proxy-agent';
const { HttpsProxyAgent } = pkg;
import path from 'path';
import { fileURLToPath } from 'url';
import Fuse from 'fuse.js'; // make sure "fuse.js": "^7.0.0" is in package.json

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// HARD-CODED PUBLIC PROXIES (replace with reliable ones later)
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
  const proxyUrl = pickProxy();
  const axiosConfig = { timeout: 20000, ...options };
  try {
    const agent = new HttpsProxyAgent(proxyUrl);
    axiosConfig.httpsAgent = agent;
    axiosConfig.httpAgent = agent;
    axiosConfig.proxy = false;
    const res = await axios.get(url, axiosConfig);
    return res;
  } catch (err) {
    console.error(`[PROXY ERROR] ${err.message} for ${url}`);
    throw err;
  }
}

/**
 * Scrape TCGplayer for market price
 */
async function scrapeTCGplayer(term) {
  const encoded = encodeURIComponent(term);
  const searchUrl = `https://www.tcgplayer.com/search/all/product?q=${encoded}`;
  try {
    console.log(`[TCGPLAYER] Searching TCGplayer for "${term}"`);
    const res = await axiosGetWithProxy(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }});
    const $ = cheerio.load(res.data);

    const firstLink = $('a.search-result__title').attr('href') || $('a.ProductCard__link').attr('href');
    if (!firstLink) {
      console.warn('[TCGPLAYER] No product link found');
      return null;
    }
    const productUrl = firstLink.startsWith('http') ? firstLink : `https://www.tcgplayer.com${firstLink}`;
    console.log(`[TCGPLAYER] Product URL: ${productUrl}`);

    const productRes = await axiosGetWithProxy(productUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }});
    const $$ = cheerio.load(productRes.data);

    let marketPriceText =
      $$('span.price--market').first().text() ||
      $$('span.marketPrice').first().text() ||
      $$('meta[itemprop="price"]').attr('content') ||
      $$('div.product-market-price').text();

    if (!marketPriceText) {
      const scriptTxt = $$('script[type="application/ld+json"]').html() || '';
      const match = scriptTxt.match(/"price":\s*"([\d\.]+)"/);
      if (match) marketPriceText = match[1];
    }

    if (!marketPriceText) {
      console.warn('[TCGPLAYER] No price found');
      return null;
    }

    const cleaned = marketPriceText.replace(/[^0-9.]/g, '');
    const marketPrice = parseFloat(cleaned);
    console.log(`[TCGPLAYER] Market Price: ${marketPrice}`);
    return isNaN(marketPrice) ? null : marketPrice;
  } catch (err) {
    console.error(`[TCGPLAYER ERROR] ${err.message}`);
    return null;
  }
}

/**
 * Scrape eBay for listings
 */
async function scrapeEbay(term) {
  const encoded = encodeURIComponent(term);
  const url = `https://www.ebay.com/sch/i.html?_nkw=${encoded}`;
  try {
    console.log(`[EBAY] Searching for "${term}"`);
    const res = await axiosGetWithProxy(url, { headers: { 'User-Agent': 'Mozilla/5.0' }});
    const $ = cheerio.load(res.data);
    const results = [];

    $('li.s-item').each((i, el) => {
      const title = $(el).find('h3.s-item__title').text().trim();
      const priceText = $(el).find('.s-item__price').first().text();
      const link = $(el).find('a.s-item__link').attr('href');
      if (!title || !priceText) return;
      const price = parseFloat(priceText.replace(/[^0-9.]/g, ''));
      if (!isNaN(price)) results.push({ title, price, link, source: 'eBay' });
    });

    console.log(`[EBAY] Found ${results.length} results`);
    return results;
  } catch (err) {
    console.error(`[EBAY ERROR] ${err.message}`);
    return [];
  }
}

/** Stubs for other retailers */
async function scrapeAmazon(term) { console.log('[AMAZON] Stub'); return []; }
async function scrapeWalmart(term) { console.log('[WALMART] Stub'); return []; }
async function scrapeTarget(term) { console.log('[TARGET] Stub'); return []; }

/**
 * Filter and normalize deals
 */
function filterDeals(allResults, marketPrice, percentage) {
  if (!marketPrice || marketPrice <= 0) {
    console.warn('[FILTER] No valid marketPrice — returning all');
    return allResults;
  }
  const ratio = percentage / 100;
  const threshold = marketPrice * ratio;
  const filtered = allResults.filter(r => r.price && r.price < threshold);
  return filtered.map(r => ({
    ...r,
    marketPrice,
    pctBelowMarket: Math.round(((marketPrice - r.price) / marketPrice) * 100)
  }));
}

/**
 * Manual Scan Endpoint
 */
app.post('/manual-scan', async (req, res) => {
  const { term = '', percentage = 40, sources = ['tcgplayer', 'ebay'] } = req.body;
  console.log(`[SCRAPER] Starting scan for "${term}" | ${percentage}% | sources: ${sources.join(', ')}`);

  const stats = { fetched: 0, errors: [] };

  try {
    // Step 1: Get market price
    let marketPrice = null;
    if (sources.includes('tcgplayer') || true) {
      marketPrice = await scrapeTCGplayer(term);
    }

    // Step 2: Gather all source scrapes
    const promises = [];
    if (sources.includes('ebay')) promises.push(scrapeEbay(term));
    if (sources.includes('amazon')) promises.push(scrapeAmazon(term));
    if (sources.includes('walmart')) promises.push(scrapeWalmart(term));
    if (sources.includes('target')) promises.push(scrapeTarget(term));

    const settled = await Promise.allSettled(
      promises.map(async p => {
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
        return await p;
      })
    );

    let allResults = [];
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') {
        const arr = s.value || [];
        stats.fetched += arr.length;
        allResults = allResults.concat(arr);
        console.log(`[SCRAPER] Source ${i} returned ${arr.length}`);
      } else {
        console.error(`[SCRAPER] Source ${i} failed: ${s.reason}`);
        stats.errors.push(String(s.reason));
      }
    });

    // Step 3: Apply fuzzy matching
    if (term && allResults.length > 0) {
      const fuse = new Fuse(allResults, {
        keys: ['title'],
        threshold: 0.4, // smaller = stricter
      });
      const fuzzyResults = fuse.search(term).map(res => res.item);
      console.log(`[FUZZY] Matched ${fuzzyResults.length} of ${allResults.length}`);
      if (fuzzyResults.length) allResults = fuzzyResults;
    }

    // Step 4: Filter below percentage threshold
    const deals = filterDeals(allResults, marketPrice, Number(percentage));
    console.log(`[SUMMARY] Scanned ${allResults.length} | Deals below ${percentage}%: ${deals.length}`);

    res.json({ success: true, term, marketPrice, scanned: allResults.length, deals, stats });
  } catch (err) {
    console.error(`[SCAN ERROR] ${err.message}`);
    res.status(500).json({ success: false, error: err.message, stats });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scraper-App running on port ${PORT}`));

