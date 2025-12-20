import gspread
import json
import os
import time
import random
from oauth2client.service_account import ServiceAccountCredentials

SPREADSHEET_ID = '1lUVs-5pmYWG-Cp-S3bYoIwmmnjvhF047vM_fDpVEjic'
SCOPES = ['https://spreadsheets.google.com/feeds', 'https://www.googleapis.com/auth/drive']

def get_sheets_data():
    # Читаем credentials из переменной окружения (GitHub Secrets)
    creds_json = os.environ.get('GOOGLE_SHEETS_CREDENTIALS')
    
    if not creds_json:
        raise Exception("GOOGLE_SHEETS_CREDENTIALS not found in environment")
    
    # Парсим JSON
    creds_dict = json.loads(creds_json)
    
    # Авторизация
    creds = ServiceAccountCredentials.from_json_keyfile_dict(creds_dict, SCOPES)
    client = gspread.authorize(creds)
    
    # Открываем таблицу с retry логикой
    max_retries = 3
    for attempt in range(max_retries):
        try:
            sheet = client.open_by_key(SPREADSHEET_ID)
            break
        except gspread.exceptions.APIError as e:
            if '429' in str(e) and attempt < max_retries - 1:
                wait_time = (attempt + 1) * 10 + random.randint(0, 10)
                print(f"⚠️ API rate limit, ожидание {wait_time} секунд...")
                time.sleep(wait_time)
            else:
                raise
    
    # Читаем лист "скины"
    skins_sheet = sheet.worksheet('скины')
    max_price = skins_sheet.cell(1, 2).value  # B1
    skins_column = skins_sheet.col_values(1)  # Столбец A
    
    # Читаем лист "патерн"
    patterns_sheet = sheet.worksheet('патерн')
    patterns_data = patterns_sheet.get_all_values()
    
    # Формируем словарь паттернов
    patterns_dict = {}
    for row in patterns_data[1:]:  # Пропускаем заголовок
        if len(row) >= 4 and row[0]:
            skin_name = row[0].strip()
            tier1_raw = row[2].strip() if len(row) > 2 else ""
            tier2_raw = row[3].strip() if len(row) > 3 else ""
            
            # Парсим паттерны и конвертируем в строки
            tier1_list = [p.strip() for p in tier1_raw.split(',') if p.strip()]
            tier2_list = [p.strip() for p in tier2_raw.split(',') if p.strip()]
            
            patterns_dict[skin_name] = {
                'tier1': tier1_list,
                'tier2': tier2_list
            }
    
    result = {
        'max_price': max_price,
        'skins': [s for s in skins_column if s],
        'patterns': patterns_dict
    }
    
    # Сохраняем в JSON для парсера
    with open('skins_data.json', 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    
    print(f"✅ Получено {len(result['skins'])} скинов")
    print(f"✅ Получено {len(result['patterns'])} скинов с паттернами")
    print(f"✅ Максимальная цена: {result['max_price']}$")
    print(f"✅ Данные сохранены в skins_data.json")
    
    return result

if __name__ == '__main__':
    get_sheets_data()
