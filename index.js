// index.js — Scraper-App using Browserless.io for rendering
import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import Fuse from "fuse.js";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Set your Browserless token in Render → Environment Variables
const BROWSERLESS_KEY = process.env.BROWSERLESS_KEY;

// fallback token for local testing (delete in prod)
if (!BROWSERLESS_KEY) console.warn("⚠ No Browserless key set — add BROWSERLESS_KEY in environment vars.");

/* -------------------------------------------------------------------------- */
/*                               Browserless Fetch                            */
/* -------------------------------------------------------------------------- */
async function getRenderedHTML(url) {
  const api = `https://chrome.browserless.io/content?token=${BROWSERLESS_KEY}`;
  console.log(`[BROWSERLESS] Rendering ${url}`);
  const body = {
    url,
    gotoOptions: { waitUntil: "networkidle2" },
  };
  const res = await fetch(api, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Browserless request failed: ${res.statusText}`);
  const html = await res.text();
  console.log(`[BROWSERLESS] Received HTML (${html.length} chars)`);
  return html;
}

/* -------------------------------------------------------------------------- */
/*                            Scrape TCGplayer Market Price                   */
/* -------------------------------------------------------------------------- */
async function scrapeTCGplayer(term) {
  const encoded = encodeURIComponent(term);
  const searchUrl = `https://www.tcgplayer.com/search/all/product?q=${encoded}`;
  try {
    console.log(`[TCGPLAYER] Searching for "${term}"`);
    const html = await getRenderedHTML(searchUrl);
    const $ = cheerio.load(html);
    const firstLink =
      $("a.search-result__title").attr("href") ||
      $("a.ProductCard__link").attr("href");
    if (!firstLink) {
      console.warn("[TCGPLAYER] No product link found");
      return null;
    }
    const productUrl = firstLink.startsWith("http")
      ? firstLink
      : `https://www.tcgplayer.com${firstLink}`;

    const productHTML = await getRenderedHTML(productUrl);
    const $$ = cheerio.load(productHTML);

    let marketPriceText =
      $$("span.price--market").first().text() ||
      $$("span.marketPrice").first().text() ||
      $$("meta[itemprop='price']").attr("content") ||
      $$("div.product-market-price").text();

    if (!marketPriceText) {
      const scriptTxt = $$("script[type='application/ld+json']").html() || "";
      const match = scriptTxt.match(/"price":\s*"([\d\.]+)"/);
      if (match) marketPriceText = match[1];
    }

    const price = parseFloat((marketPriceText || "").replace(/[^0-9.]/g, ""));
    if (!price) {
      console.warn("[TCGPLAYER] Could not parse market price");
      return null;
    }

    console.log(`[TCGPLAYER] Market Price for "${term}": $${price}`);
    return price;
  } catch (err) {
    console.error(`[TCGPLAYER ERROR] ${err.message}`);
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*                                Scrape eBay                                 */
/* -------------------------------------------------------------------------- */
async function scrapeEbay(term) {
  const encoded = encodeURIComponent(term);
  const url = `https://www.ebay.com/sch/i.html?_nkw=${encoded}`;
  console.log(`[EBAY] Searching for "${term}"`);

  try {
    const html = await getRenderedHTML(url);
    const $ = cheerio.load(html);
    const results = [];

    $("li.s-item").each((i, el) => {
      const title = $(el).find("h3.s-item__title").text().trim();
      const priceText = $(el).find(".s-item__price").first().text();
      const link = $(el).find("a.s-item__link").attr("href");
      if (!title || !priceText) return;
      const price = parseFloat(priceText.replace(/[^0-9.]/g, ""));
      if (!isNaN(price)) results.push({ title, price, link, source: "eBay" });
    });

    console.log(`[EBAY] Found ${results.length} eBay results`);
    return results;
  } catch (err) {
    console.error(`[EBAY ERROR] ${err.message}`);
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/*                               Other Retailers                              */
/* -------------------------------------------------------------------------- */
async function scrapeAmazon(term) {
  console.log("[AMAZON] Stub");
  return [];
}
async function scrapeWalmart(term) {
  console.log("[WALMART] Stub");
  return [];
}
async function scrapeTarget(term) {
  console.log("[TARGET] Stub");
  return [];
}

/* -------------------------------------------------------------------------- */
/*                             Filtering & Fuzzy Match                        */
/* -------------------------------------------------------------------------- */
function filterDeals(allResults, marketPrice, percentage) {
  if (!marketPrice || marketPrice <= 0) {
    console.warn("[FILTER] No valid marketPrice; returning all");
    return allResults;
  }
  const ratio = percentage / 100;
  const threshold = marketPrice * ratio;
  const filtered = allResults.filter((r) => r.price && r.price < threshold);
  return filtered.map((r) => ({
    ...r,
    marketPrice,
    pctBelowMarket: Math.round(((marketPrice - r.price) / marketPrice) * 100),
  }));
}

/* -------------------------------------------------------------------------- */
/*                                Manual Scan                                 */
/* -------------------------------------------------------------------------- */
app.post("/manual-scan", async (req, res) => {
  const { term = "", percentage = 40, sources = ["tcgplayer", "ebay"] } = req.body;
  console.log(`[SCRAPER] Start scan for "${term}" | ${percentage}% | ${sources.join(", ")}`);

  const stats = { fetched: 0, errors: [] };

  try {
    // 1) Market price
    let marketPrice = null;
    if (sources.includes("tcgplayer")) {
      marketPrice = await scrapeTCGplayer(term);
    }

    // 2) Scrape sources
    const promises = [];
    if (sources.includes("ebay")) promises.push(scrapeEbay(term));
    if (sources.includes("amazon")) promises.push(scrapeAmazon(term));
    if (sources.includes("walmart")) promises.push(scrapeWalmart(term));
    if (sources.includes("target")) promises.push(scrapeTarget(term));

    const settled = await Promise.allSettled(promises);
    let allResults = [];
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") {
        const arr = s.value || [];
        stats.fetched += arr.length;
        allResults = allResults.concat(arr);
        console.log(`[SCRAPER] Source ${i} returned ${arr.length}`);
      } else {
        console.error(`[SCRAPER] Source ${i} failed: ${s.reason}`);
        stats.errors.push(String(s.reason));
      }
    });

    // 3) Fuzzy search
    if (term && allResults.length > 0) {
      const fuse = new Fuse(allResults, { keys: ["title"], threshold: 0.4 });
      const fuzzyResults = fuse.search(term).map((r) => r.item);
      if (fuzzyResults.length) allResults = fuzzyResults;
      console.log(`[FUZZY] Matched ${fuzzyResults.length} of ${allResults.length}`);
    }

    // 4) Filter
    const deals = filterDeals(allResults, marketPrice, Number(percentage));
    console.log(`[SUMMARY] Found ${deals.length} deals`);

    res.json({ success: true, term, marketPrice, scanned: allResults.length, deals, stats });
  } catch (err) {
    console.error(`[SCAN ERROR] ${err.message}`);
    res.status(500).json({ success: false, error: err.message, stats });
  }
});

/* -------------------------------------------------------------------------- */
/*                                 Launch                                     */
/* -------------------------------------------------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Scraper-App (Browserless) running on port ${PORT}`));
