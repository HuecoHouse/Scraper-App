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
const THRESHOLD_RATIO = 0.4;
let searchOptions = ['pokemon'];

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

async function scrapeTCGplayer(productLine) {
  const deals = [];
  const marketPrice = await fetchTCGMarketPrice(productLine);
  if (!marketPrice) return deals;
  const threshold = marketPrice * THRESHOLD_RATIO;
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

async function scrapeEbay(productLine) {
  const deals = [];
  const marketPrice = await fetchTCGMarketPrice(productLine);
  if (!marketPrice) return deals;
  const threshold = marketPrice * THRESHOLD_RATIO;
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

async function scrapeRetailers(productLine) {
  return [];
}

async function scanProduct(productLine) {
  const results = [];
  const tcgDeals = await scrapeTCGplayer(productLine);
  const ebayDeals = await scrapeEbay(productLine);
  const retailDeals = await scrapeRetailers(productLine);
  return results.concat(tcgDeals, ebayDeals, retailDeals);
}

async function runScanAll() {
  let allResults = [];
  for (const opt of searchOptions) {
    const deals = await scanProduct(opt);
    allResults = allResults.concat(deals);
  }
  return allResults;
}

// schedule scanning every 3 hours
cron.schedule('0 */3 * * *', async () => {
  const results = await runScanAll();
  console.log('Scheduled scan completed', results);
});

// settings API
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

app.post('/manual-scan', async (req, res) => {
  const results = await runScanAll();
  res.json({ results });
});

app.get('/', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
