// index.js — Puppeteer-powered scraper server
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";
import Fuse from "fuse.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/* ------------------------ Utility Functions ------------------------ */

async function scrapeWithPuppeteer(url, pageFn) {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  const results = await page.evaluate(pageFn);
  await browser.close();
  return results;
}

/* ---------------------- Scrape TCGplayer Price --------------------- */
async function scrapeTCGplayer(term) {
  const encoded = encodeURIComponent(term);
  const searchUrl = `https://www.tcgplayer.com/search/all/product?q=${encoded}`;
  console.log(`[TCGPLAYER] Searching for "${term}"`);
  try {
    const productUrl = await scrapeWithPuppeteer(searchUrl, () => {
      const link =
        document.querySelector("a.search-result__title")?.href ||
        document.querySelector("a.ProductCard__link")?.href;
      return link || null;
    });

    if (!productUrl) {
      console.warn("[TCGPLAYER] No product link found");
      return null;
    }

    console.log(`[TCGPLAYER] Found product URL: ${productUrl}`);

    const price = await scrapeWithPuppeteer(productUrl, () => {
      const priceSelectors = [
        "span.price--market",
        "span.marketPrice",
        "meta[itemprop='price']",
        "div.product-market-price",
      ];
      let text = "";
      for (const sel of priceSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          text =
            el.content || el.textContent || el.innerText || el.getAttribute("content");
          if (text) break;
        }
      }
      return parseFloat(text.replace(/[^0-9.]/g, "")) || null;
    });

    if (!price) {
      console.warn("[TCGPLAYER] Could not extract market price");
      return null;
    }

    console.log(`[TCGPLAYER] Market Price for "${term}": $${price}`);
    return price;
  } catch (err) {
    console.error(`[TCGPLAYER ERROR] ${err.message}`);
    return null;
  }
}

/* -------------------------- Scrape eBay ---------------------------- */
async function scrapeEbay(term) {
  const encoded = encodeURIComponent(term);
  const url = `https://www.ebay.com/sch/i.html?_nkw=${encoded}`;
  console.log(`[EBAY] Searching for "${term}"`);

  try {
    const results = await scrapeWithPuppeteer(url, () => {
      const items = [];
      document.querySelectorAll("li.s-item").forEach((el) => {
        const title = el.querySelector("h3.s-item__title")?.innerText?.trim();
        const priceText = el.querySelector(".s-item__price")?.innerText;
        const link = el.querySelector("a.s-item__link")?.href;
        if (!title || !priceText) return;
        const price = parseFloat(priceText.replace(/[^0-9.]/g, ""));
        if (!isNaN(price))
          items.push({ title, price, link, source: "eBay" });
      });
      return items;
    });
    console.log(`[EBAY] Found ${results.length} eBay results`);
    return results;
  } catch (err) {
    console.error(`[EBAY ERROR] ${err.message}`);
    return [];
  }
}

/* ------------------- Stubs for Other Retailers -------------------- */
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

/* ---------------------- Filter Deal Logic ------------------------- */
function filterDeals(allResults, marketPrice, percentage) {
  if (!marketPrice || marketPrice <= 0) {
    console.warn("[FILTER] No valid marketPrice, returning all");
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

/* ---------------------- Manual Scan Endpoint ---------------------- */
app.post("/manual-scan", async (req, res) => {
  const { term = "", percentage = 40, sources = ["tcgplayer", "ebay"] } = req.body;
  console.log(
    `[SCRAPER] Starting scan for "${term}" | threshold: ${percentage}% | sources: ${sources.join(
      ", "
    )}`
  );

  const stats = { fetched: 0, errors: [] };

  try {
    // 1) Market price
    let marketPrice = null;
    if (sources.includes("tcgplayer") || true) {
      marketPrice = await scrapeTCGplayer(term);
    }

    // 2) Source scraping
    const scrapers = [];
    if (sources.includes("ebay")) scrapers.push(scrapeEbay(term));
    if (sources.includes("amazon")) scrapers.push(scrapeAmazon(term));
    if (sources.includes("walmart")) scrapers.push(scrapeWalmart(term));
    if (sources.includes("target")) scrapers.push(scrapeTarget(term));

    const settled = await Promise.allSettled(scrapers);
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

    // 3) Fuzzy match titles
    if (term && allResults.length > 0) {
      const fuse = new Fuse(allResults, {
        keys: ["title"],
        threshold: 0.4,
      });
      const fuzzyResults = fuse.search(term).map((r) => r.item);
      if (fuzzyResults.length) allResults = fuzzyResults;
      console.log(`[FUZZY] Matched ${fuzzyResults.length} of ${allResults.length}`);
    }

    // 4) Filter below threshold
    const deals = filterDeals(allResults, marketPrice, Number(percentage));
    console.log(
      `[SUMMARY] Scanned: ${allResults.length} | Deals below ${percentage}%: ${deals.length}`
    );

    res.json({ success: true, term, marketPrice, scanned: allResults.length, deals, stats });
  } catch (err) {
    console.error(`[SCAN ERROR] ${err.message}`);
    res.status(500).json({ success: false, error: err.message, stats });
  }
});

/* ---------------------------- Start ------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🟡 Scraper-App (Puppeteer) running on port ${PORT}`)
);
