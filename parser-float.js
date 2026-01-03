const puppeteer = require('puppeteer');
const fs = require('fs');
const axios = require('axios');

// ===================== CONFIG =====================
const DATA_FILE = process.env.DATA_FILE || 'skins_data.json';

// Telegram
const TG_BOT_TOKEN = process.env.API_TG;
const TG_CHAT_ID = process.env.ID;

// Workers
const WORKER_ID = parseInt(process.env.WORKER_ID || '1', 10);
const TOTAL_WORKERS = parseInt(process.env.TOTAL_WORKERS || '1', 10);

// Парсинг лимиты
const STOP_MULTIPLIER = 1.30; // +30% от первой цены

// Паузы (антибан)
const DELAY_BETWEEN_PAGES_MS = () => 20000 + Math.random() * 2000;
const DELAY_BETWEEN_TARGETS_MS = () => 20000 + Math.random() * 2000;

// Puppeteer
const HEADLESS = (process.env.HEADLESS || 'true').toLowerCase() !== 'false';
// ==================================================


// --------- Utils ----------
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function parsePriceToNumber(priceText) {
  if (!priceText) return null;
  const s0 = String(priceText)
    .replace(/\u00A0/g, ' ')  // nbsp
    .trim();

  // выдёргиваем "число с разделителями"
  const m = s0.match(/(\d[\d\s.,]*)/);
  if (!m) return null;

  let s = m[1].replace(/\s/g, '');

  // если и точка и запятая — десятичный та, что позже
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');

  if (hasDot && hasComma) {
    if (s.lastIndexOf('.') > s.lastIndexOf(',')) {
      // dot decimal
      s = s.replace(/,/g, '');
    } else {
      // comma decimal
      s = s.replace(/\./g, '').replace(/,/g, '.');
    }
  } else if (hasComma && !hasDot) {
    // comma decimal
    s = s.replace(/,/g, '.');
  }

  const val = parseFloat(s);
  return Number.isFinite(val) ? val : null;
}

async function sendToTelegram(message) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;

  try {
    await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      chat_id: TG_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (e) {
    console.error('❌ Telegram error:', e.message);
  }
}
// --------------------------


// --------- Load targets ----------
const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
const maxPrice = Number(data.max_price);
const allTargets = Array.isArray(data.targets) ? data.targets : [];

if (!Number.isFinite(maxPrice)) {
  throw new Error(`max_price is invalid in ${DATA_FILE}: ${data.max_price}`);
}

// Делим таргеты между воркерами
const perWorker = Math.ceil(allTargets.length / TOTAL_WORKERS);
const startIndex = (WORKER_ID - 1) * perWorker;
const endIndex = Math.min(startIndex + perWorker, allTargets.length);
const targets = allTargets.slice(startIndex, endIndex);

console.log(`🤖 Worker ${WORKER_ID}/${TOTAL_WORKERS}`);
console.log(`📦 Targets total: ${allTargets.length}, mine: ${startIndex + 1}-${endIndex} (${targets.length})`);
console.log(`💰 Max price (sheet H1): $${maxPrice}`);
console.log(`🧯 Stop when price > firstPrice * ${STOP_MULTIPLIER}\n`);
// --------------------------------


// --------- Steam parsing ----------
async function gotoListing(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

  // Если листингов нет — селектор не появится
  await page.waitForSelector('.market_listing_row.market_recent_listing_row', { timeout: 15000 });
}

/**
 * Возвращает первую цену на странице (самый дешёвый листинг)
 */
async function getFirstListingPrice(page) {
  const first = await page.evaluate(() => {
    const row = document.querySelector('.market_listing_row.market_recent_listing_row');
    if (!row) return null;
    const el = row.querySelector('.market_listing_price.market_listing_price_with_fee');
    return el ? el.textContent.trim() : null;
  });
  return parsePriceToNumber(first);
}

/**
 * Парсит текущую страницу:
 * - идёт по листингам сверху вниз
 * - если цена > stopPrice => прекращает (и не ховерит дальше)
 * - иначе получает float через hover и, если float <= floatMax => возвращает в found[]
 */
async function parseCurrentPage(page, stopPrice, floatMax) {
  const result = await page.evaluate(async (stopPriceInner, floatMaxInner) => {
    function parsePriceInBrowser(txt) {
      if (!txt) return null;
      const s0 = String(txt).replace(/\u00A0/g, ' ').trim();
      const m = s0.match(/(\d[\d\s.,]*)/);
      if (!m) return null;

      let s = m[1].replace(/\s/g, '');
      const hasDot = s.includes('.');
      const hasComma = s.includes(',');

      if (hasDot && hasComma) {
        if (s.lastIndexOf('.') > s.lastIndexOf(',')) s = s.replace(/,/g, '');
        else s = s.replace(/\./g, '').replace(/,/g, '.');
      } else if (hasComma && !hasDot) {
        s = s.replace(/,/g, '.');
      }

      const v = parseFloat(s);
      return Number.isFinite(v) ? v : null;
    }

    async function extractFloatFromHover() {
      // Ждём появление блока с Wear Rating
      for (let a = 0; a < 40; a++) {
        await new Promise(r => setTimeout(r, 50));

        const blocks = document.querySelectorAll('._3JCkAyd9cnB90tRcDLPp4W');
        for (const block of blocks) {
          const text = block.innerText || block.textContent || '';
          if (!text) continue;

          if (text.includes('Wear Rating')) {
            const m = text.match(/Wear Rating[:\s]*([\d,\.]+)/i);
            if (m) {
              const raw = m[1];
              const num = parseFloat(raw.replace(',', '.'));
              if (Number.isFinite(num)) return num;
            }
          }
        }
      }
      return null;
    }

    const listings = document.querySelectorAll('.market_listing_row.market_recent_listing_row');
    const found = [];
    let stoppedByPrice = false;
    let lastPrice = null;

    for (let i = 0; i < listings.length; i++) {
      const listing = listings[i];

      const priceEl = listing.querySelector('.market_listing_price.market_listing_price_with_fee');
      const priceText = priceEl ? priceEl.textContent.trim() : null;
      const price = parsePriceInBrowser(priceText);
      lastPrice = price;

      if (price != null && stopPriceInner != null && price > stopPriceInner) {
        stoppedByPrice = true;
        break;
      }

      // hover чтобы получить float
      const nameEl = listing.querySelector('.market_listing_item_name');
      if (!nameEl) continue;

      nameEl.scrollIntoView({ behavior: 'auto', block: 'center' });
      const rect = nameEl.getBoundingClientRect();

      nameEl.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }));

      const fl = await extractFloatFromHover();

      nameEl.dispatchEvent(new MouseEvent('mouseout', {
        bubbles: true,
        cancelable: true,
        view: window,
      }));

      if (fl != null && fl <= floatMaxInner) {
        const listingId = (listing.id || '').replace('listing_', '');
        found.push({
          listingId,
          priceText,
          price,
          float: fl,
          indexOnPage: i + 1,
        });
      }
    }

    return { found, stoppedByPrice, lastPrice };
  }, stopPrice, floatMax);

  return result;
}


async function parseTarget(page, target, idx, total) {
  const { listing_name, float_max, wear, weapon, skin } = target;

  console.log(`\n🔍 [${idx}/${total}] ${listing_name}`);
  console.log(`   🎯 float <= ${float_max}`);

  const encoded = encodeURIComponent(listing_name);
  const baseUrl = `https://steamcommunity.com/market/listings/730/${encoded}`;

  try {
    await gotoListing(page, baseUrl);
    await sleep(DELAY_BETWEEN_PAGES_MS());
  } catch (e) {
    console.log(`   ❌ Page load failed: ${e.message} (skip)`);
    return;
  }

  const firstPrice = await getFirstListingPrice(page);
  if (!Number.isFinite(firstPrice)) {
    console.log(`   ⚠️ Can't read first price (skip)`);
    return;
  }

  const stopByFirst = firstPrice * STOP_MULTIPLIER;
  const stopPrice = Math.min(maxPrice, stopByFirst);

  console.log(`   💵 firstPrice=$${firstPrice.toFixed(2)} | stop at min($${maxPrice.toFixed(2)}, $${stopByFirst.toFixed(2)}) = $${stopPrice.toFixed(2)}`);

  let pageIndex = 0;
  const sent = new Set(); // чтобы не слать один и тот же listingId

  while (true) {
    console.log(`   📄 page #${pageIndex + 1} (start=${pageIndex * 10})`);

    const { found, stoppedByPrice } = await parseCurrentPage(page, stopPrice, Number(float_max));

    for (const item of found) {
      if (item.listingId && sent.has(item.listingId)) continue;
      if (item.listingId) sent.add(item.listingId);

      const pos = pageIndex * 10 + (item.indexOnPage || 0);
      console.log(`   ✅ FOUND float=${item.float} price=${item.priceText} pos=#${pos}`);

      const msg =
        `✅ <b>Low-float найден</b>\n\n` +
        `<b>Скин:</b> ${weapon} | ${skin}\n` +
        `<b>Износ:</b> ${wear}\n` +
        `<b>Порог float:</b> ${Number(float_max)}\n` +
        `<b>Float:</b> ${item.float}\n` +
        `<b>Цена:</b> ${item.priceText || 'N/A'}\n` +
        `<b>Позиция:</b> #${pos}\n\n` +
        `<a href="${baseUrl}">🔗 Открыть Steam Market</a>`;

      await sendToTelegram(msg);
    }

    if (stoppedByPrice) {
      console.log(`   🛑 Stop: price exceeded stopPrice`);
      break;
    }

    // next page
    pageIndex += 1;
    const nextUrl = `${baseUrl}?start=${pageIndex * 10}&count=10`;

    try {
      await gotoListing(page, nextUrl);
      await sleep(DELAY_BETWEEN_PAGES_MS());
    } catch (e) {
      console.log(`   ❌ Next page failed: ${e.message} (stop this target)`);
      break;
    }
  }
}
// --------------------------------


// --------- Main ----------
(async () => {
  console.log('🚀 Start parser...\n');

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  await page.setViewport({ width: 1920, height: 1080 });

  const total = targets.length;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    await parseTarget(page, t, i + 1, total);

    const d = DELAY_BETWEEN_TARGETS_MS();
    console.log(`⏳ sleep ${Math.round(d / 1000)}s...`);
    await sleep(d);
  }

  await browser.close();
  console.log('\n✅ Done.');
})();
