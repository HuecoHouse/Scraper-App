import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import nodemailer from 'nodemailer';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const MIN_DISCOUNT = 0.3; // 30%

// Initial search options, representing product lines on TCGplayer
let searchOptions = ['pokemon'];

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Send email notification
async function sendEmail(subject, message) {
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: process.env.RECEIVER_EMAIL,
    subject,
    text: message,
  });
}

// Scrape TCGplayer deals for a given product line
async function scanTCGPlayer(productLine = 'pokemon') {
  console.log(`🔍 Scanning TCGplayer for ${productLine}...`);
  const url = `https://www.tcgplayer.com/search/${productLine}/product?page=1&productLineName=${productLine}`;

  const { data } = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    },
  });

  const $ = cheerio.load(data);
  const items = [];

  $('.search-result__content').each((_, el) => {
    const title = $(el).find('.search-result__title').text().trim();
    const priceText = $(el).find('.search-result__market-price--value').text().replace('$', '');
    const listingText = $(el).find('.search-result__price-with-shipping').text().replace('$', '');
    const link = 'https://www.tcgplayer.com' + $(el).find('a').attr('href');

    const market = parseFloat(priceText);
    const listing = parseFloat(listingText);

    if (!isNaN(market) && !isNaN(listing) && listing < market * (1 - MIN_DISCOUNT)) {
      items.push({ title, listing, market, link });
    }
  });

  if (items.length > 0) {
    let body = `🔥 ${productLine.toUpperCase()} Deals Found:\n\n`;
    items.forEach((i) => {
      body += `${i.title}\nMarket: $${i.market} | Listing: $${i.listing}\n${i.link}\n\n`;
    });
    console.log('📩 Sending email...');
    await sendEmail(`🔥 New ${productLine.toUpperCase()} Deals Found!`, body);
  } else {
    console.log(`No deals found for ${productLine} this cycle.`);
  }
}

// Run scan for all search options
async function runScanAll() {
  for (const opt of searchOptions) {
    await scanTCGPlayer(opt);
  }
}

// Schedule scanning every 3 hours
cron.schedule('0 */3 * * *', runScanAll);

// API endpoints
app.get('/settings', (req, res) => {
  res.json({ searchOptions });
});

app.post('/settings', (req, res) => {
  const { newOption } = req.body;
  if (newOption) {
    const opt = newOption.toLowerCase();
    if (!searchOptions.includes(opt)) {
      searchOptions.push(opt);
    }
  }
  res.json({ searchOptions });
});

app.post('/manual-scan', async (req, res) => {
  await runScanAll();
  res.json({ message: 'Manual scan completed.' });
});

// Serve index.html from public folder on root path
app.get('/', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
