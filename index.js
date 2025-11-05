import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
let searchOptions = ['pokemon'];

// Fetch TCGplayer market price for product line
async function fetchTCGMarketPrice(productLine) {
  try {
    const url = `https://www.tcgplayer.com/search/${productLine}/product`;
    const response = await axios.get(url);
    const $ = cheerio.load(response.data);
    const priceText = $('.search-result__market-price .value').first().text().trim().replace('$','');
    const market = parseFloat(priceText);
    return market || null;
  } catch (err) {
    console.error('Error fetching market price', err.message);
    return null;
  }
}

// Scrape TCGplayer deals below threshold ratio
async function scrapeTCGplayer(productLine, ratio) {
  const deals = [];
  const marketPrice = await fetchTCGMarketPrice(productLine);
  if (!marketPrice) return deals;
  const threshold = marketPrice * ratio;
  const url = `https://www.tcgplayer.com/search/${productLine}/product?productLineName=${productLine}`;
  const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const $ = cheerio.load(response.data);
  $('.search-result__content').each((i, el) => {
    const name = $(el).find('.search-result__title').text().trim();
    const listPriceText = $(el).find('.search-result__market-price-with-shipping .value').text().replace('$','');
    const listPrice = parseFloat(listPriceText);
    if (listPrice && listPrice <= threshold) {
      const link = $(el).find('a').attr('href');
      deals.push({ title: name, price: listPrice, marketPrice, source: 'TCGplayer', link: `https://www.tcgplayer.com${link}` });
    }
  });
  return deals;
}

// Scrape eBay deals below threshold ratio
async function scrapeEbay(productLine, ratio) {
  const deals = [];
  const marketPrice = await fetchTCGMarketPrice(productLine);
  if (!marketPrice) return deals;
  const threshold = marketPrice * ratio;
  const searchQuery = encodeURIComponent(`${productLine} cards`);
  const url = `https://www.ebay.com/sch/i.html?_nkw=${searchQuery}`;
  const response = await axios.get(url);
  const $ = cheerio.load(response.data);
  $('.s-item').each((i, el) => {
    const name = $(el).find('.s-item__title').text().trim();
    const priceText = $(el).find('.s-item__price').first().text().replace(/[^\d.]/g, '');
    const price = parseFloat(priceText);
    if (price && price <= threshold) {
      const link = $(el).find('.s-item__link').attr('href');
      deals.push({ title: name, price, marketPrice, source: 'eBay', link });
    }
  });
  return deals;
}

// Placeholder for scraping other retailers like Walmart, Target, Amazon
async function scrapeRetailers(productLine, ratio, sources = []) {
  // Could implement scraping for each store; return empty for now
  return [];
}

// Scan product across selected sources and ratio
async function scanProduct(productLine, ratio, sources) {
  let results = [];
  if (!sources || sources.includes('tcgplayer')) {
    const tcgDeals = await scrapeTCGplayer(productLine, ratio);
    results = results.concat(tcgDeals);
  }
  if (!sources || sources.includes('ebay')) {
    const ebayDeals = await scrapeEbay(productLine, ratio);
    results = results.concat(ebayDeals);
  }
  if (!sources || sources.some(src => ['walmart','target','amazon'].includes(src))) {
    const retailDeals = await scrapeRetailers(productLine, ratio, sources);
    results = results.concat(retailDeals);
  }
  return results;
}

// Run scans for all search options (default ratio 0.4 and all sources)
async function runScanAll(ratio = 0.4, sources) {
  let allResults = [];
  for (const opt of searchOptions) {
    const deals = await scanProduct(opt, ratio, sources);
    allResults = allResults.concat(deals);
  }
  return allResults;
}

// Scheduled scanning every 3 hours using default ratio and all sources
cron.schedule('0 */3 * * *', async () => {
  const results = await runScanAll();
  console.log('Scheduled scan completed', results);
});

// Settings endpoints
app.get('/settings', (req, res) => {
  res.json({ searchOptions });
});

app.post('/settings', (req, res) => {
  const { newOption } = req.body;
  if (newOption) {
    const opt = newOption.toLowerCase();
    if (!searchOptions.includes(opt)) searchOptions.push(opt);
  }
  res.json({ searchOptions });
});

// Manual scan endpoint with custom percentage and sources
app.post('/manual-scan', async (req, res) => {
  let { percentage, sources } = req.body;
  const ratio = (parseFloat(percentage) || 40) / 100;
  const results = await runScanAll(ratio, sources);
  const message = results.length ? '' : 'No deals found for current scan.';
  res.json({ results, message });
});

// Root route
app.get('/', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

// Start server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
