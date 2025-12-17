const puppeteer = require('puppeteer');
const fs = require('fs');
const axios = require('axios');

// Telegram настройки
const TG_BOT_TOKEN = process.env.API_TG;
const TG_CHAT_ID = process.env.ID;

// Загружаем данные из Google Sheets
const skinsData = JSON.parse(fs.readFileSync('skins_data.json', 'utf-8'));
const maxPrice = parseFloat(skinsData.max_price.replace('$', ''));
const skinsList = skinsData.skins;
const patternsData = skinsData.patterns;

console.log(`📊 Загружено скинов: ${skinsList.length}`);
console.log(`💰 Максимальная цена: ${maxPrice}$`);
console.log(`🎯 Скинов с паттернами: ${Object.keys(patternsData).length}\n`);

// Отправка в Telegram
async function sendToTelegram(message) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.log('⚠️ Telegram не настроен, пропускаем отправку');
    return;
  }
  
  try {
    await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      chat_id: TG_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    });
    console.log('✅ Отправлено в Telegram');
  } catch (error) {
    console.error('❌ Ошибка отправки в Telegram:', error.message);
  }
}

// Извлекаем базовое название скина (без состояния)
function getBaseSkinName(fullName) {
  // Убираем состояние в скобках и StatTrak/Souvenir
  let base = fullName
    .replace(/StatTrak™\s*/i, '')
    .replace(/Souvenir\s*/i, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
  return base;
}

// Конвертируем цену в число
function parsePrice(priceText) {
  if (!priceText) return null;
  const match = priceText.match(/([\d,\.]+)/);
  if (!match) return null;
  return parseFloat(match[1].replace(',', '.'));
}

// Парсим один скин
async function parseSkin(page, skinName, skinNumber, totalSkins) {
  const baseSkinName = getBaseSkinName(skinName);
  const hasPatterns = patternsData[baseSkinName];
  
  if (!hasPatterns) {
    console.log(`⏭️ Скип ${skinName} - нет паттернов для проверки`);
    return;
  }
  
  const tier1 = hasPatterns.tier1 || [];
  const tier2 = hasPatterns.tier2 || [];
  
  console.log(`\n🔍 Парсинг скина ${skinNumber}/${totalSkins}: ${skinName}`);
  console.log(`   Tier 1 паттерны: ${tier1.length}, Tier 2: ${tier2.length}`);
  
  const encodedName = encodeURIComponent(skinName);
  const url = `https://steamcommunity.com/market/listings/730/${encodedName}`;
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('.market_listing_row.market_recent_listing_row', { timeout: 10000 });
    await new Promise(r => setTimeout(r, 1500));
  } catch (error) {
    console.log(`❌ Ошибка загрузки страницы: ${error.message}`);
    return;
  }
  
  // Получаем количество страниц
  const totalPages = await page.evaluate(() => {
    const pageLinks = document.querySelectorAll('#searchResults_links .market_paging_pagelink');
    if (pageLinks.length === 0) return 1;
    const lastPageLink = pageLinks[pageLinks.length - 1];
    return parseInt(lastPageLink.textContent.trim());
  });
  
  console.log(`   📄 Страниц: ${totalPages}`);
  
  let currentPage = 0;
  let shouldStop = false;
  let foundCount = 0;
  
  while (currentPage < totalPages && !shouldStop) {
    console.log(`   📄 Парсинг страницы ${currentPage + 1}/${totalPages}...`);
    
    const results = await page.evaluate(async () => {
      const listings = document.querySelectorAll('.market_listing_row.market_recent_listing_row');
      const results = [];
      
      for (let i = 0; i < listings.length; i++) {
        const listing = listings[i];
        const nameElement = listing.querySelector('.market_listing_item_name');
        
        const data = {
          listingId: listing.id.replace('listing_', ''),
          price: null,
          pattern: null,
          float: null
        };
        
        const priceElement = listing.querySelector('.market_listing_price.market_listing_price_with_fee');
        if (priceElement) {
          data.price = priceElement.textContent.trim();
        }
        
        nameElement.scrollIntoView({ behavior: 'auto', block: 'center' });
        const rect = nameElement.getBoundingClientRect();
        
        nameElement.dispatchEvent(new MouseEvent('mouseover', { 
          bubbles: true, 
          cancelable: true,
          view: window,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2
        }));
        
        let attempts = 0;
        let foundData = false;
        
        while (attempts < 40 && !foundData) {
          await new Promise(resolve => setTimeout(resolve, 50));
          attempts++;
          
          const allBlocks = document.querySelectorAll('._3JCkAyd9cnB90tRcDLPp4W');
          
          for (let block of allBlocks) {
            const text = block.innerText || block.textContent;
            
            if (text.includes('Wear Rating') || text.includes('Pattern Template')) {
              const floatMatch = text.match(/Wear Rating[:\s]*([\d,\.]+)/i);
              if (floatMatch) {
                data.float = parseFloat(floatMatch[1].replace(',', '.'));
              }
              
              const patternMatch = text.match(/Pattern Template[:\s]*(\d+)/i);
              if (patternMatch) {
                data.pattern = parseInt(patternMatch[1]);
              }
              
              foundData = true;
              break;
            }
          }
          
          if (foundData) break;
        }
        
        nameElement.dispatchEvent(new MouseEvent('mouseout', { 
          bubbles: true, 
          cancelable: true,
          view: window 
        }));
        
        results.push(data);
      }
      
      return results;
    });
    
    // Проверяем результаты
    for (let i = 0; i < results.length; i++) {
      const item = results[i];
      const price = parsePrice(item.price);
      const itemNumber = currentPage * 10 + i + 1;  // Номер предмета на странице
      
      // Если цена превышает максимум - останавливаем парсинг этого скина
      if (price && price > maxPrice) {
        console.log(`   💰 Цена ${price}$ > ${maxPrice}$ - останавливаем`);
        shouldStop = true;
        break;
      }
      
      // Проверяем паттерн
      if (item.pattern) {
        const patternStr = item.pattern.toString();
        let tier = null;
        
        if (tier1.includes(patternStr)) {
          tier = 1;
        } else if (tier2.includes(patternStr)) {
          tier = 2;
        }
        
        if (tier) {
          foundCount++;
          const listingUrl = `https://steamcommunity.com/market/listings/730/${encodedName}`;
          
          console.log(`   ✨ НАЙДЕН! Паттерн ${item.pattern} - Tier ${tier}`);
          console.log(`   💰 Цена: ${item.price}`);
          console.log(`   🔗 ${listingUrl}`);
          
          const message = `🎯 <b>Найден скин с редким паттерном!</b>\n\n` +
            `<b>Скин ${skinNumber}/${totalSkins}:</b> ${skinName}\n` +
            `<b>Позиция:</b> #${itemNumber} на странице ${currentPage + 1}\n` +
            `<b>Паттерн:</b> ${item.pattern}\n` +
            `<b>Тир:</b> ${tier}\n` +
            `<b>Цена:</b> ${item.price}\n` +
            `<b>Float:</b> ${item.float || 'N/A'}\n\n` +
            `<a href="${listingUrl}">🔗 Открыть на Steam Market</a>`;
          
          await sendToTelegram(message);
        }
      }
    }
    
    if (shouldStop) break;
    
    // Переходим на следующую страницу
    currentPage++;
    if (currentPage < totalPages) {
      const nextPageUrl = `${url}?start=${currentPage * 10}&count=10`;
      await page.goto(nextPageUrl, { waitUntil: 'networkidle2', timeout: 60000 });
      await page.waitForSelector('.market_listing_row.market_recent_listing_row');
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  
  console.log(`   ✅ Найдено редких паттернов: ${foundCount}`);
}

// Главная функция
(async () => {
  console.log('🚀 Запуск парсера...\n');
  
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  
  let parsedCount = 0;
  const totalSkins = skinsList.filter(s => s).length;
  
  for (let i = 0; i < skinsList.length; i++) {
    const skin = skinsList[i];
    if (!skin) continue;
    
    parsedCount++;
    await parseSkin(page, skin, parsedCount, totalSkins);
    
    // Небольшая пауза между скинами
    await new Promise(r => setTimeout(r, 2000));
  }
  
  console.log(`\n✅ Парсинг завершен. Обработано скинов: ${parsedCount}`);
  
  await browser.close();
})();
