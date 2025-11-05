import express from "express";
import puppeteer from "puppeteer-core";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BROWSERLESS_ENDPOINT = "wss://production-sfo.browserless.io/?token=2TMsfgcxIaoua4obc5980a604ae6d525a56a8bc63d04a815c";

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

async function getRenderedHTML(url) {
  console.log(`[BROWSERLESS] Launching headless for ${url}`);
  let browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: BROWSERLESS_ENDPOINT,
    });
    const page = await browser.newPage();
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });
    const html = await page.content();
    console.log(`[BROWSERLESS] Received HTML (${html.length} chars)`);
    return html;
  } catch (err) {
    console.error(`[BROWSERLESS ERROR] ${err.message}`);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

app.post("/manual-scan", async (req, res) => {
  const { term = "", percentage = 40, sources = ["tcgplayer", "ebay"] } = req.body;
  console.log(`[SCRAPER] Start scan for "${term}" | ${percentage}% | ${sources.join(", ")}`);

  const results = [];

  try {
    if (sources.includes("tcgplayer")) {
      const url = `https://www.tcgplayer.com/search/all/product?q=${encodeURIComponent(term)}`;
      const html = await getRenderedHTML(url);
      if (html) {
        results.push({ title: `TCGplayer page for ${term}`, source: "TCGplayer", price: 0, link: url });
      }
    }

    if (sources.includes("ebay")) {
      const url = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(term)}`;
      const html = await getRenderedHTML(url);
      if (html) {
        results.push({ title: `eBay page for ${term}`, source: "eBay", price: 0, link: url });
      }
    }

    console.log(`[SUMMARY] Scraped ${results.length} pages total`);
    res.json({ success: true, deals: results });
  } catch (err) {
    console.error(`[SCRAPER ERROR] ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Scraper-App running on port ${PORT}`));

