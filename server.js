const express = require("express");
const { chromium } = require("playwright"); // or firefox / webkit
const app = express();
const PORT = process.env.PORT || 3000;

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
];

function normalize(text) {
  return text.toLowerCase()
    .replace(/\s/g, "")
    .replace(/['\/\-\:]/g, "");
}

function getField(html, labelText) {
  const { load } = require("cheerio"); // still using cheerio for parsing
  const $ = load(html);

  if (!$) return "_ _";

  const labelNorm = normalize(labelText);
  let result = "_ _";

  $("span").each((i, el) => {
    const spanText = normalize($(el).text());
    if (spanText.includes(labelNorm)) {
      const next = $(el).next("p").text().trim();
      const prev = $(el).prev("p").text().trim();
      if (next) {
        result = next;
        return false;
      }
      if (prev) {
        result = prev;
        return false;
      }
      const parentP = $(el).parent().find("p").first().text().trim();
      if (parentP) {
        result = parentP;
        return false;
      }
    }
  });

  return result || "_ _";
}

let browser = null;
let context = null;

// Lazy-init browser (shared across requests)
async function getBrowserContext() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",           // often helps in containers
        "--disable-infobars",
      ]
    });
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
      extraHTTPHeaders: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.google.com/"
      },
      ignoreHTTPSErrors: true,
    });
  }
  return context;
}

async function fetchVehicleData(vehicleNumber) {
  let page = null;
  try {
    const context = await getBrowserContext();
    page = await context.newPage();

    const url = `https://vahanx.in/rc-search/${vehicleNumber}`;

    // Optional: rotate user-agent per request
    await page.setExtraHTTPHeaders({
      "User-Agent": USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
    });

    // Load page and wait until mostly idle
    await page.goto(url, {
      waitUntil: "networkidle",
      timeout: 45000
    });

    // Wait for "Owner Name" text to appear (strong signal content is ready)
    try {
      await page.waitForSelector("text=/owner name/i", {
        timeout: 15000,
        state: "visible"
      });
    } catch (e) {
      console.warn(`Owner name text not found within timeout for ${vehicleNumber}`);
      // continue anyway — maybe fallback data is still present
    }

    const html = await page.content();

    const fields = {
      owner_name:        "Owner Name",
      father_name:       "Father's Name",
      owner_serial_no:   "Owner Serial No",
      rto_address:       "Address",
      rto_phone:         "Phone",
      rto_website:       "Website",
      model_name:        "Model Name",
      maker_model:       "Maker Model",
      vehicle_class:     "Vehicle Class",
      fuel_type:         "Fuel Type",
      fuel_norms:        "Fuel Norms",
      chassis_number:    "Chassis Number",
      engine_number:     "Engine Number",
      registration_date: "Registration Date",
      fitness_upto:      "Fitness Upto",
      tax_upto:          "Tax Upto",
      puc_upto:          "PUC Upto",
      insurance_expiry:  "Insurance Expiry",
      insurance_company: "Insurance Company",
      financer_name:     "Financer Name",
      cubic_capacity:    "Cubic Capacity",
      seating_capacity:  "Seating Capacity",
      blacklist_status:  "Blacklist Status",
      permit_type:       "Permit Type",
      noc_details:       "NOC Details",
      puc_expiry_in:     "PUC Expiry In",
      vehicle_age:       "Vehicle Age",
      insurance_upto:    "Insurance Upto",
      insurance_expiry_in: "Insurance Expiry In",
      rto_code:          "Code",
      rto_city:          "City Name",
      registered_rto:    "Registered RTO"
    };

    const data = {};
    for (const key in fields) {
      data[key] = getField(html, fields[key]);
    }

    return data;

  } catch (err) {
    console.error(`Playwright error for ${vehicleNumber}:`, err.message);
    throw err; // let caller handle
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

app.get("/rc", async (req, res) => {
  const vehNo = req.query.query;
  if (!vehNo) {
    return res.status(400).json({
      status: "error",
      message: "query parameter missing"
    });
  }

  const cleanNumber = vehNo.toUpperCase().replace(/[^A-Z0-9]/g, "");

  let data;
  try {
    data = await fetchVehicleData(cleanNumber);
  } catch (err) {
    // fallback empty object
    data = {};
    [
      "owner_name","father_name","owner_serial_no","rto_address","rto_phone","rto_website",
      "model_name","maker_model","vehicle_class","fuel_type","fuel_norms","chassis_number",
      "engine_number","registration_date","fitness_upto","tax_upto","puc_upto",
      "insurance_expiry","insurance_company","financer_name","cubic_capacity",
      "seating_capacity","blacklist_status","permit_type","noc_details",
      "puc_expiry_in","vehicle_age","insurance_upto","insurance_expiry_in",
      "rto_code","rto_city","registered_rto"
    ].forEach(k => data[k] = "_ _");
  }

  res.json({
    status: "success",
    vehicle_number: cleanNumber,
    ...data
  });
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down...");
  if (browser) await browser.close();
  process.exit(0);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🪪🏠 Address & Owner Name RC API (Playwright) running at http://localhost:${PORT}/rc?query=PB13BU4064 🏠🪪`);
});