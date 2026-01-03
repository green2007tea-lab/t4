import os
import json
import time
import random
from dataclasses import dataclass, asdict
from typing import List, Dict, Optional, Tuple

import gspread
from oauth2client.service_account import ServiceAccountCredentials


# ===================== CONFIG =====================
SPREADSHEET_ID = os.getenv("SPREADSHEET_ID", "1lUVs-5pmYWG-Cp-S3bYoIwmmnjvhF047vM_fDpVEjic")
SCOPES = [
    "https://spreadsheets.google.com/feeds",
    "https://www.googleapis.com/auth/drive",
]

FLOAT_SHEET_NAME = os.getenv("FLOAT_SHEET_NAME", "флоат")
MAX_PRICE_CELL = os.getenv("MAX_PRICE_CELL", "H1")  # здесь максимум в $
OUT_JSON = os.getenv("OUT_JSON", "skins_data.json")

# Заголовки износа в таблице (как в Steam)
WEAR_HEADERS = {
    "factory new": "Factory New",
    "minimal wear": "Minimal Wear",
    "field-tested": "Field-Tested",
    "field tested": "Field-Tested",
    "well-worn": "Well-Worn",
    "well worn": "Well-Worn",
    "battle-scarred": "Battle-Scarred",
    "battle scarred": "Battle-Scarred",
}

WEAPON_HEADER_KEYS = {"оружие", "weapon"}
NAME_HEADER_KEYS = {"название", "name", "skin", "скин"}
# ==================================================


@dataclass(frozen=True)
class FloatTarget:
    weapon: str
    skin: str
    wear: str                 # Steam wear name
    float_max: float
    listing_name: str         # "AK-47 | Emerald Pinstripe (Factory New)"


def _parse_number(raw: str) -> Optional[float]:
    """
    Парсит числа вида:
    "0.01", "0,01", "$12.34", "12,34$", " 12.34 "
    """
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None

    # убираем валюту и мусор, оставляем цифры и разделители
    allowed = set("0123456789.,")
    cleaned = "".join(ch for ch in s if ch in allowed)

    if not cleaned:
        return None

    # если есть и точка и запятая — десятичный разделитель считаем тот, что встречается позже
    if "." in cleaned and "," in cleaned:
        if cleaned.rfind(".") > cleaned.rfind(","):
            # "." десятичный, "," тысячные
            cleaned = cleaned.replace(",", "")
        else:
            # "," десятичный, "." тысячные
            cleaned = cleaned.replace(".", "").replace(",", ".")
    else:
        # если только запятая — считаем её десятичной
        if "," in cleaned and "." not in cleaned:
            cleaned = cleaned.replace(",", ".")

    try:
        return float(cleaned)
    except ValueError:
        return None


def _authorize_gsheets() -> gspread.Client:
    creds_json = os.environ.get("GOOGLE_SHEETS_CREDENTIALS")
    if not creds_json:
        raise RuntimeError("GOOGLE_SHEETS_CREDENTIALS not found in environment")

    creds_dict = json.loads(creds_json)
    creds = ServiceAccountCredentials.from_json_keyfile_dict(creds_dict, SCOPES)
    return gspread.authorize(creds)


def _open_spreadsheet_with_retry(client: gspread.Client, spreadsheet_id: str, max_retries: int = 5):
    for attempt in range(max_retries):
        try:
            return client.open_by_key(spreadsheet_id)
        except gspread.exceptions.APIError as e:
            if "429" in str(e) and attempt < max_retries - 1:
                wait_time = 30 + (attempt * 15) + random.randint(0, 30)
                print(f"⚠️ Google API rate limit (попытка {attempt + 1}/{max_retries}), жду {wait_time}с...")
                time.sleep(wait_time)
            else:
                raise


def _find_col_idx(headers: List[str], keys: set) -> Optional[int]:
    for i, h in enumerate(headers):
        if h is None:
            continue
        if str(h).strip().casefold() in keys:
            return i
    return None


def _collect_wear_cols(headers: List[str]) -> Dict[int, str]:
    """
    Возвращает {col_index: wear_name_in_steam}
    """
    wear_cols: Dict[int, str] = {}
    for i, h in enumerate(headers):
        if not h:
            continue
        key = str(h).strip().casefold()
        if key in WEAR_HEADERS:
            wear_cols[i] = WEAR_HEADERS[key]
    return wear_cols


def _build_listing_name(weapon: str, skin: str, wear: str) -> str:
    base = f"{weapon.strip()} | {skin.strip()}"
    return f"{base} ({wear})"


def get_sheets_data() -> dict:
    client = _authorize_gsheets()
    sheet = _open_spreadsheet_with_retry(client, SPREADSHEET_ID)

    ws = sheet.worksheet(FLOAT_SHEET_NAME)

    # max price из H1
    max_price_raw = ws.acell(MAX_PRICE_CELL).value
    max_price = _parse_number(max_price_raw)
    if max_price is None:
        raise RuntimeError(
            f"Не смог прочитать max price из {FLOAT_SHEET_NAME}!{MAX_PRICE_CELL}. "
            f"Текущее значение: {max_price_raw!r}. Впиши туда число (например 25 или $25)."
        )

    values = ws.get_all_values()
    if not values or len(values) < 2:
        raise RuntimeError(f"Лист '{FLOAT_SHEET_NAME}' пустой или нет данных кроме заголовков.")

    headers = values[0]
    weapon_idx = _find_col_idx(headers, WEAPON_HEADER_KEYS)
    name_idx = _find_col_idx(headers, NAME_HEADER_KEYS)
    if weapon_idx is None or name_idx is None:
        raise RuntimeError(
            f"Не нашёл заголовки 'оружие' и/или 'название' в первой строке листа '{FLOAT_SHEET_NAME}'. "
            f"Сейчас заголовки: {headers}"
        )

    wear_cols = _collect_wear_cols(headers)
    if not wear_cols:
        raise RuntimeError(
            f"Не нашёл колонки износа. Ожидаю заголовки типа: "
            f"{', '.join(sorted(set(WEAR_HEADERS.values())))}"
        )

    targets: List[FloatTarget] = []

    for r in values[1:]:
        weapon = (r[weapon_idx].strip() if weapon_idx < len(r) else "")
        skin = (r[name_idx].strip() if name_idx < len(r) else "")
        if not weapon or not skin:
            continue

        for col_i, wear in wear_cols.items():
            cell = r[col_i].strip() if col_i < len(r) else ""
            if not cell:
                continue

            fmax = _parse_number(cell)
            if fmax is None:
                continue

            targets.append(
                FloatTarget(
                    weapon=weapon,
                    skin=skin,
                    wear=wear,
                    float_max=fmax,
                    listing_name=_build_listing_name(weapon, skin, wear),
                )
            )

    result = {
        "max_price": max_price,  # number
        "targets": [asdict(t) for t in targets],
    }

    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"✅ MAX PRICE: ${max_price}")
    print(f"✅ Targets (wear+float): {len(targets)}")
    print(f"✅ Saved: {OUT_JSON}")

    return result


if __name__ == "__main__":
    get_sheets_data()
