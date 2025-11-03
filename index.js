// 🧩 Simple Pokémon Deal Tracker (Node.js + Express + Cheerio)
// Checks TCGplayer listings for deals >= 30% under market
// Email notifications via Nodemailer

// === 1. Install dependencies ===
// npm init -y
// npm install express axios cheerio nodemailer node-cron dotenv

// === 2. Create .env file ===
// EMAIL_USER=your_email@gmail.com
// EMAIL_PASS=your_app_password
// RECEIVER_EMAIL=stishficks01@gmail.com

import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import nodemailer from 'nodemailer';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const MIN_DISCOUNT = 0.3; // 30%

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// --- Helper: Send Email ---
async function sendEmail(subject, message) {
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: process.env.RECEIVER_EMAIL,
    subject,
    text: message,
  });
}

// --- Scraper Function ---
async function scanTCGPlayer() {
  console.log('🔍 Scanning TCGplayer...');
  const url = 'https://www.tcgplayer.com/search/pokemon/product?page=1&productLineName=pokemon';

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
    let body = '🔥 Pokémon Deals Found:\n\n';
    items.forEach((i) => {
      body += `${i.title}\nMarket: $${i.market} | Listing: $${i.listing}\n${i.link}\n\n`;
    });
    console.log('📩 Sending email...');
    await sendEmail('🔥 New Pokémon Deals Found!', body);
  } else {
    console.log('No deals found this cycle.');
  }
}

// --- Schedule every 3 hours ---
cron.schedule('0 */3 * * *', scanTCGPlayer);

// --- Simple web interface ---
app.get('/', (req, res) => {
  res.send('<h1>Pokémon Deal Tracker is running ✅</h1><p>Scanning TCGplayer every 3 hours.</p>');
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
