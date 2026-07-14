import * as XLSX from 'xlsx';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { toStrictStringCode, cleanCategory } from './utils';

dayjs.extend(utc);
dayjs.extend(timezone);

export interface OrderData {
  code: string;
  original_name?: string;
  price?: string | number;
  cost?: string | number;
  margin_rate?: string | number;
  category?: string[];
  mall?: string;
  account?: string;
  internal_code?: string;
  sales_count?: number;
  date?: string;
  supplier?: string;
  // Optional fields for DB sync and filtering
  stats_period?: string;
  stats_account?: string;
  final_title?: string;
  updated_at?: string;
  last_exported_at?: string;
  total_inflow?: number;
  inflow_keywords?: string;
  auto_keywords?: string;
  related_keywords?: string;
  filter_attributes?: string;
  tags?: string | string[];
  top_keyword?: string;
  rank_tracking_url?: string;
  is_favorite?: boolean;
  avg_exposure_rank?: number;
  channel_name?: string;
  display_badge_name?: string | null;
}

export interface SalesAnalysisResult {
  summary: {
    totalSales: number;
    netProfit: number;
    totalAdSpend: number;
    avgRoas: number;
  };
  trends: {
    date: string;
    sales: number;
    adSpend: number;
  }[];
  channels: {
    name: string;
    value: number;
  }[];
  topProducts: {
    code: string;
    name: string;
    sales: number;
    profit: number;
    marginRate: number;
    count: number;
  }[];
}

const findColumnValue = (row: any, possibleKeys: string[]): any => {
  const keys = Object.keys(row);
  for (const key of possibleKeys) {
    const trimmedKey = key.trim();
    const actualKey = keys.find(k => k.trim() === trimmedKey);
    if (actualKey && row[actualKey] !== undefined) {
      return row[actualKey];
    }
  }
  return '';
};

const findColumnByKeywords = (row: any, keywords: string[]): any => {
  const keys = Object.keys(row);
  for (const key of keys) {
    // Check if key contains ALL keywords (case-insensitive)
    const keyLower = key.toLowerCase();
    const match = keywords.every(kw => keyLower.includes(kw.toLowerCase()));
    if (match) {
      return row[key];
    }
  }
  return undefined;
};

const findColumnBySanitizedIncludes = (row: any, keyword: string): any => {
  const keys = Object.keys(row);
  const sanitizedTarget = keyword.replace(/[\r\n\s]+/g, '');
  for (const key of keys) {
    const sanitizedKey = key.replace(/[\r\n\s]+/g, '');
    if (sanitizedKey.includes(sanitizedTarget)) {
      return row[key];
    }
  }
  return undefined;
};

export interface RelatedKeyword {
  keyword: string;
  totalSearchCount: number;
  duplicateCount: number;
  analyzedWords: string[];
  splitWords?: string[];
  representative_category?: string;
  product_count?: number;
  competition_intensity?: number;
}

export const parseRelatedKeywords = (file: File): Promise<{ 
  keywords: RelatedKeyword[], 
  category?: string,
  stats?: { dominantCategory: string, removedCount: number, totalCount: number }
}> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: 'binary' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const jsonData = XLSX.utils.sheet_to_json(worksheet);

        if (jsonData.length === 0) {
          resolve({ keywords: [] });
          return;
        }

        // 1. Identify Category Columns
        const firstRow = jsonData[0] as any;
        const catKeys = Object.keys(firstRow).filter(k => /전송카테고리명|상품카테고리|카테고리|Category/i.test(k));

        // 2. Calculate Category Frequencies
        const categoryFreqMap = new Map<string, number>();
        const rowToCategory = new Map<any, string>();

        jsonData.forEach((row: any) => {
          let rowCat = '';
          if (catKeys.length === 1) {
            const val = row[catKeys[0]];
            rowCat = cleanCategory(Array.isArray(val) ? val.join('>') : val) || '';
          } else if (catKeys.length > 1) {
            const sortedCatKeys = [...catKeys].sort((a, b) => {
              const getOrder = (k: string) => {
                if (k.includes('대')) return 1;
                if (k.includes('중')) return 2;
                if (k.includes('소')) return 3;
                if (k.includes('세')) return 4;
                return 99;
              };
              return getOrder(a) - getOrder(b);
            });
            const catParts = sortedCatKeys.map(k => String(row[k] || '').trim()).filter(v => v);
            rowCat = cleanCategory(catParts.join('>')) || '';
          }
          
          if (rowCat) {
            categoryFreqMap.set(rowCat, (categoryFreqMap.get(rowCat) || 0) + 1);
            rowToCategory.set(row, rowCat);
          }
        });

        // 3. Determine Dominant Category
        let dominantCategory = '';
        let maxFreq = 0;
        categoryFreqMap.forEach((freq, cat) => {
          if (freq > maxFreq) {
            maxFreq = freq;
            dominantCategory = cat;
          }
        });

        // 4. Strict Filtering (With Safe Fallback)
        const originalCount = jsonData.length;
        let filteredJsonData = jsonData.filter(row => rowToCategory.get(row) === dominantCategory);
        
        if (filteredJsonData.length === 0) {
          filteredJsonData = jsonData;
        }
        const removedCount = originalCount - filteredJsonData.length;

        const keywordsList: RelatedKeyword[] = [];
        const keywordMap = new Map<string, RelatedKeyword>();

        filteredJsonData.forEach((row: any) => {
          // Flexible Header Matching
          // Keyword: contains '키워드'
          let keywordRaw = findColumnByKeywords(row, ['키워드']);
          // Fallback to exact match if flexible fails (though flexible covers it)
          if (!keywordRaw) keywordRaw = findColumnValue(row, ['연관키워드', '키워드']);
          
          let keyword = String(keywordRaw || '');
          // Remove all spaces (leading, trailing, and middle)
          keyword = keyword.replace(/\s+/g, '');
          if (!keyword) return;

          // Total Search Count: contains '총' AND '검색수'
          let searchCountRaw = findColumnByKeywords(row, ['총', '검색수']);
          if (searchCountRaw === undefined) searchCountRaw = findColumnValue(row, ['총 검색수', '총검색수', '검색수', '월간검색수(PC)', '월간검색수(모바일)']); // Fallbacks
          
          let searchCount = 0;
          if (typeof searchCountRaw === 'number') {
            searchCount = searchCountRaw;
          } else if (typeof searchCountRaw === 'string') {
             searchCount = parseInt(searchCountRaw.replace(/,/g, ''), 10) || 0;
          }

          // Duplicate Count: contains '중복' AND '횟수' or just '중복'
          let duplicateCountRaw = findColumnByKeywords(row, ['중복', '횟수']);
          if (duplicateCountRaw === undefined) duplicateCountRaw = findColumnValue(row, ['중복횟수', '중복']);

          let duplicateCount = 0;
          if (typeof duplicateCountRaw === 'number') {
            duplicateCount = duplicateCountRaw;
          } else if (typeof duplicateCountRaw === 'string') {
            // Remove non-numeric characters and parse
            const cleaned = duplicateCountRaw.replace(/[^0-9]/g, '');
            duplicateCount = cleaned ? parseInt(cleaned, 10) : 0;
          }

          // [Task] Data Entrance Refinement: NLUTERMS Spacing Rules
          const analyzedWords = keyword
            .replace(/([a-zA-Z]+)([0-9]+)/g, '$1 $2')
            .replace(/([0-9]+)([a-zA-Z]+)/g, '$1 $2')
            .replace(/([a-zA-Z0-9]+)([가-힣]+)/g, '$1 $2')
            .replace(/([가-힣]+)([a-zA-Z0-9]+)/g, '$1 $2')
            .replace(/\s+/g, ' ')
            .trim()
            .split(' ');

          // Parse extra fields for standard schemas
          let repCatRaw = findColumnValue(row, ['대표 카테고리', '대표카테고리', '대표 카테고리명', '대표카테고리명', '대표_카테고리_명']);
          if (repCatRaw === undefined || repCatRaw === '') {
            repCatRaw = findColumnValue(row, ['카테고리', 'Category', 'category', '카테고리명', '카테고리 명']);
          }
          const representativeCategory = repCatRaw ? String(repCatRaw).trim() : '';

          let prodCountRaw = findColumnValue(row, ['상품수', '상품 수', '등록상품수', '등록 상품수', '총 상품수', 'product_count', 'Product Count', '상품개수', '상품 수(개)']);
          let productCount = 0;
          if (typeof prodCountRaw === 'number') {
            productCount = prodCountRaw;
          } else if (typeof prodCountRaw === 'string') {
            productCount = parseInt(prodCountRaw.replace(/,/g, ''), 10) || 0;
          }

          let compIntensityRaw = findColumnValue(row, ['경쟁강도', '경쟁 강도', '경쟁률', '경쟁도', '경쟁 비율', 'competition_intensity', 'Competition Intensity', '경쟁강도(수치)']);
          let competitionIntensity = 0;
          if (typeof compIntensityRaw === 'number') {
            competitionIntensity = compIntensityRaw;
          } else if (typeof compIntensityRaw === 'string') {
            competitionIntensity = parseFloat(compIntensityRaw.replace(/,/g, '')) || 0;
          }

          const newEntry: RelatedKeyword = {
            keyword,
            totalSearchCount: searchCount,
            duplicateCount: duplicateCount,
            analyzedWords: analyzedWords,
            representative_category: representativeCategory,
            product_count: productCount,
            competition_intensity: competitionIntensity
          };

          // Deduplicate: keep the one with the highest totalSearchCount
          if (keywordMap.has(keyword)) {
            const existingEntry = keywordMap.get(keyword)!;
            if (searchCount > existingEntry.totalSearchCount) {
              keywordMap.set(keyword, newEntry);
            }
          } else {
            keywordMap.set(keyword, newEntry);
          }
        });

        // Convert map to array
        keywordMap.forEach((value) => {
          keywordsList.push(value);
        });

        // Sort by Total Search Count (Desc), then Duplicate Count (Desc)
        keywordsList.sort((a, b) => {
          if (b.totalSearchCount !== a.totalSearchCount) {
            return b.totalSearchCount - a.totalSearchCount;
          }
          return b.duplicateCount - a.duplicateCount;
        });

        resolve({ 
          keywords: keywordsList, 
          category: dominantCategory || undefined,
          stats: dominantCategory ? {
            dominantCategory,
            removedCount,
            totalCount: keywordsList.length
          } : undefined
        });
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = (error) => reject(error);
    reader.readAsBinaryString(file);
  });
};

export const parseExcelFile = (file: File): Promise<OrderData[]> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: 'binary' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const jsonData = XLSX.utils.sheet_to_json(worksheet);

        const parsedData: OrderData[] = jsonData.map((row: any) => {
          const categoryRaw = String(findColumnValue(row, ['전송카테고리명', '상품카테고리', '카테고리'])).trim();
          const cleanedCategoryStr = cleanCategory(categoryRaw);
          const category = cleanedCategoryStr ? cleanedCategoryStr.split('>').map(s => s.trim()).filter(s => s.length > 0) : [];
          
          // Code Normalization Logic
          let codeRaw = findColumnValue(row, ['마켓상품코드', '쇼핑몰상품코드', '상품코드']);
          let code = toStrictStringCode(codeRaw);

          // Internal Code Logic
          // Candidate Keywords: ['상품코드(쇼핑몰)', '고객사상품코드', '도매매 상품번호', '자사코드', '관리번호']
          const internalCodeRaw = findColumnValue(row, ['상품코드(쇼핑몰)', '고객사상품코드', '도매매 상품번호', '자사코드', '관리번호']);
          const internalCode = String(internalCodeRaw || '').trim();

          return {
            code: code,
            original_name: String(findColumnValue(row, ['상품명', '주문상품명'])).trim(),
            price: findColumnValue(row, ['판매가격', '판매가(원)', '판매가']),
            cost: findColumnValue(row, ['공급가격', '공급가(원)', '공급가']),
            margin_rate: findColumnValue(row, ['마진율(%)', '마진율']),
            category: category,
            mall: String(findColumnValue(row, ['쇼핑몰명', '마켓명', '쇼핑몰'])).trim() || '-',
            account: String(findColumnValue(row, ['계정명', '계정ID', '계정'])).trim() || '-',
            internal_code: internalCode,
            sales_count: Number(findColumnValue(row, ['판매수량', '판매수', '수량', '주문수량', '결제수량', '주문이력건수', '판매건수'])) || 0,
            date: formatToISO(findColumnValue(row, ['상품전송일', '주문일시', '등록일', '수집일', 'Date', 'Time']))
          };
        });

        resolve(parsedData);
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = (error) => reject(error);
    reader.readAsBinaryString(file);
  });
};

export interface ShopmineSale {
  id?: string;
  order_unique_code: string;
  order_no: string;
  order_at: string;
  mall_name: string;
  mall_id: string;
  account_alias: string;
  seller_product_code: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  settlement_expected_amount: number;
  actual_payment_amount: number;
  actual_payment_with_shipping: number;
  market_fee_amount: number;
  shipping_fee: number | null;
  shipping_fee_type?: string | null;
  raw_shipping_fee?: string;
  actual_selling_price?: number;
  order_status: string;
  market_product_id: string;
  total_order_amount: number;
  options: string;
  discount_amount: number;
  product_url: string;
  fee_rate: number;
  order_count: number;
  sm_sales_count: number;
  supplier?: string;
  purchase_unit_price?: number;
  created_at?: string;
  purchase_price?: number;
  purchase_shipping_fee?: number;
  courier: string;
  tracking_number: string;
  cost_status: string;
  option_barcode?: string;
}

const cleanNumber = (val: any): number => {
  if (val === undefined || val === null || val === '') return 0;
  if (typeof val === 'number') return val;
  // Remove commas, currency symbols, and other non-numeric characters except dots and minus
  const s = val.toString().replace(/[^0-9.-]+/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
};

const parseShippingFee = (val: any): number | null => {
  if (val === undefined || val === null || val === '') return null;
  if (typeof val === 'number') return val;
  
  let s = String(val).replace(/,/g, '').trim();
  if (s === '') return null;
  
  // Extract only digits for shipping fee as requested
  const digitsOnly = s.replace(/[^0-9]/g, '');
  if (digitsOnly) {
    return parseInt(digitsOnly, 10);
  }

  if (s.includes('묶음') || s.includes('무료') || s.includes('조건부무료')) {
    return 0;
  }
  
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
};

export const formatToISO = (val: any): string => {
  // Use Asia/Seoul as default timezone for all operations
  const nowKst = dayjs().tz('Asia/Seoul');
  // Default to current KST time with full precision
  const defaultDate = nowKst.format('YYYY-MM-DD HH:mm:ss+09:00');

  if (val === undefined || val === null || val === '') return defaultDate;
  
  let d: dayjs.Dayjs;
  
  // Handle Excel Serial Date (Number)
  if (typeof val === 'number') {
    // [Task] 시간 데이터 보존 로직 (Preserve Full Timestamp)
    // 1. Math.floor() 삭제 및 밀리초 단위 계산으로 정밀도 유지
    // 2. 엑셀 일련번호(Serial)를 밀리초로 변환하여 UTC 기준일(1899-12-30)에 더함
    const ms = Math.round(val * 86400000);
    d = dayjs.utc('1899-12-30').add(ms, 'ms');
    
    // KST(+09) 강제 주입 및 ISO 형식 변환
    // 엑셀의 시리얼 번호가 나타내는 시각을 그대로 KST 시각으로 해석
    const dateStr = d.format('YYYY-MM-DD HH:mm:ss');
    const kstWithOffset = dayjs.tz(dateStr, 'Asia/Seoul').format('YYYY-MM-DD HH:mm:ss+09');
    
    return kstWithOffset;
  } else {
    const dateStr = String(val).trim();
    if (dateStr === '') return defaultDate;

    // [Task] 문자열 파싱 시에도 시간 정보 보존
    const s = dateStr
      .replace('오전', 'AM')
      .replace('오후', 'PM')
      .replace(/\./g, '-')
      .replace(/\//g, '-')
      .replace(/-\s+/g, '-')
      .trim();

    // dayjs를 사용하여 파싱 후 KST 오프셋 부여
    try {
      d = dayjs.tz(s, 'Asia/Seoul');
      
      if (!d.isValid()) {
        // 파싱 실패 시 날짜 부분만이라도 시도 (시간은 00:00:00으로 유지되나 원본이 없을 경우의 최후 수단)
        const datePart = s.split(' ')[0].split('T')[0];
        d = dayjs.tz(`${datePart} 00:00:00`, 'Asia/Seoul');
      }
    } catch (err) {
      return defaultDate;
    }
    
    if (!d.isValid()) return defaultDate;

    const kstWithOffset = d.format('YYYY-MM-DD HH:mm:ss+09');
    
    return kstWithOffset;
  }
};

export const parseShopmineFile = (file: File): Promise<ShopmineSale[]> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: 'binary' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const jsonData = XLSX.utils.sheet_to_json(worksheet);
        
        if (jsonData.length === 0) {
          resolve([]);
          return;
        }

        // Check mandatory headers
        const firstRow = jsonData[0] as any;
        const rowKeys = Object.keys(firstRow).map(k => k.trim());
        const mandatory = ['주문고유코드', '주문번호', '판매자상품코드'];
        const missing = mandatory.filter(m => !rowKeys.includes(m));
        
        if (missing.length > 0) {
          throw new Error(`필수 헤더가 누락되었습니다: ${missing.join(', ')}`);
        }

        const normalized: ShopmineSale[] = jsonData.map((row: any) => {
          const orderUniqueCode = String(findColumnValue(row, ['주문고유코드', '고유코드'])).trim();
          const orderNo = String(findColumnValue(row, ['주문번호'])).trim();
          
          const marketProductIdRaw = findColumnValue(row, ['상품번호', '마켓상품번호', '상품번호(쇼핑몰)']);
          const marketProductId = marketProductIdRaw !== undefined && marketProductIdRaw !== null
            ? (typeof marketProductIdRaw === 'number' ? marketProductIdRaw.toFixed(0) : String(marketProductIdRaw).trim())
            : '';

          const feeRateRaw = findColumnValue(row, ['수수료율', '수수료']);
          let feeRate = 0;
          if (feeRateRaw !== undefined && feeRateRaw !== null && feeRateRaw !== '') {
            const s = String(feeRateRaw).replace(/%/g, '').trim();
            let n = parseFloat(s);
            if (!isNaN(n)) {
              if (String(feeRateRaw).includes('%') || n >= 1) {
                feeRate = n / 100;
              } else {
                feeRate = n;
              }
            }
          }

          const orderAt = formatToISO(findColumnValue(row, ['주문일시', '결제일시', '주문일']));

          return {
            order_unique_code: orderUniqueCode,
            order_no: orderNo,
            order_at: orderAt,
            mall_name: String(findColumnValue(row, ['쇼핑몰', '마켓명'])).trim() || '-',
            mall_id: String(findColumnValue(row, ['쇼핑몰ID', '마켓ID'])).trim() || '-',
            account_alias: String(findColumnValue(row, ['별칭(쇼핑몰계정)', '쇼핑몰계정', '계정명'])).trim() || '-',
            seller_product_code: String(findColumnValue(row, ['판매자상품코드', '자사상품코드', '상품코드'])).trim(),
            product_name: String(findColumnValue(row, ['상품명', '주문상품명'])).trim(),
            quantity: cleanNumber(findColumnValue(row, ['수량', '주문수량'])),
            unit_price: cleanNumber(findColumnValue(row, ['단가', '판매단가'])),
            settlement_expected_amount: cleanNumber(findColumnValue(row, ['정산예정금액(배송비포함)', '정산예정금액'])),
            actual_payment_amount: cleanNumber(findColumnValue(row, ['실결제금액', '결제금액'])),
            actual_payment_with_shipping: cleanNumber(findColumnValue(row, ['실결제금액(배송비포함)', '실결제금액', '결제금액'])),
            market_fee_amount: cleanNumber(findColumnValue(row, ['마켓수수료금액', '수수료'])),
            shipping_fee: parseShippingFee(findColumnValue(row, ['배송비'])),
            shipping_fee_type: String(row['배송구분'] || row['배송비구분'] || '').trim() || null,
            raw_shipping_fee: String(findColumnValue(row, ['배송비']) || '').trim(),
            order_status: String(findColumnValue(row, ['주문상태'])).trim() || '결제완료',
            market_product_id: marketProductId,
            total_order_amount: cleanNumber(findColumnValue(row, ['총주문금액', '주문금액'])),
            options: String(findColumnValue(row, ['선택사항', '옵션']) || '').trim(),
            discount_amount: cleanNumber(findColumnValue(row, ['할인금액'])),
            product_url: String(findColumnValue(row, ['상품URL', 'URL']) || '').trim(),
            fee_rate: feeRate,
            order_count: 0, // Will be calculated below
            sm_sales_count: 0, // Will be calculated below
            courier: String(findColumnValue(row, ['택배사', '택배사명']) || '').trim(),
            tracking_number: String(findColumnValue(row, ['송장번호', '운송장번호']) || '').trim(),
            cost_status: String(findColumnValue(row, ['매입상태', '매입가상태']) || 'PENDING').trim(),
            option_barcode: String(findColumnValue(row, ['바코드', '옵션바코드', '단품바코드']) || '').trim()
          };
        });

        // [Task] Deduplication Algorithm Implementation
        // 1. Sort by Product ID and Time for O(N log N) performance
        normalized.sort((a, b) => {
          if (a.market_product_id !== b.market_product_id) {
            return a.market_product_id.localeCompare(b.market_product_id);
          }
          return new Date(a.order_at).getTime() - new Date(b.order_at).getTime();
        });

        // 2. Group by Product + Time Proximity (Threshold: 3 minutes)
        const TIME_THRESHOLD_MS = 3 * 60 * 1000;
        const seenOrderNos = new Set<string>();

        for (let i = 0; i < normalized.length; i++) {
          const current = normalized[i];
          
          // sm_sales_count logic: Deduplicate by Product ID + Time proximity
          if (i === 0) {
            current.sm_sales_count = 1;
          } else {
            const prev = normalized[i - 1];
            const currTime = new Date(current.order_at).getTime();
            const prevTime = new Date(prev.order_at).getTime();
            
            const isSameProduct = current.market_product_id === prev.market_product_id && current.market_product_id !== '';
            const isCloseTime = Math.abs(currTime - prevTime) <= TIME_THRESHOLD_MS;

            if (isSameProduct && isCloseTime) {
              current.sm_sales_count = 0;
            } else {
              current.sm_sales_count = 1;
            }
          }

          // order_count logic: Deduplicate by Order Number (Standard)
          if (current.order_no && !seenOrderNos.has(current.order_no)) {
            current.order_count = 1;
            seenOrderNos.add(current.order_no);
          } else {
            current.order_count = 0;
          }
        }
        
        resolve(normalized);
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = (error) => reject(error);
    reader.readAsBinaryString(file);
  });
};

export const parsePurchaseFile = (file: File, source: 'MASTER' | 'ORDER' = 'MASTER'): Promise<any[]> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: 'binary' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        
        // [Improvement] Use raw rows to handle multi-line headers (common in Shappling)
        const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];
        if (rows.length === 0) {
          throw new Error("엑셀 파일에 데이터가 없습니다.");
        }

        // 1. Find the header row (Scan first 10 rows)
        let headerRowIndex = -1;
        for (let i = 0; i < Math.min(rows.length, 10); i++) {
          const row = rows[i];
          if (row.some(cell => {
            const s = String(cell || '');
            return s.includes('상품코드') || s.includes('바코드') || s.includes('공급가') || s.includes('매입가');
          })) {
            headerRowIndex = i;
            break;
          }
        }

        if (headerRowIndex === -1) headerRowIndex = 0;

        // 2. Handle 2-line header merging
        // If the next row contains "수정불가" or "상세", it's likely a sub-header
        let finalHeaders = rows[headerRowIndex].map(h => String(h || '').trim());
        if (headerRowIndex + 1 < rows.length) {
          const nextRow = rows[headerRowIndex + 1];
          const isSecondHeader = nextRow.some(cell => {
            const s = String(cell || '');
            return s.includes('수정불가') || s.includes('상세') || s.includes('코드');
          });
          
          if (isSecondHeader) {
            finalHeaders = finalHeaders.map((h, idx) => {
              const sub = String(nextRow[idx] || '').trim();
              if (!h && sub) return sub;
              if (h && sub && h !== sub) return `${h}\n${sub}`;
              return h;
            });
            headerRowIndex++; // Skip the second header row
          }
        }

        // 3. Process data rows
        const dataRows = rows.slice(headerRowIndex + 1);
        const normalized = dataRows.filter(rowArray => rowArray.length > 0).map((rowArray) => {
          // Convert array to object using merged headers
          const row: any = {};
          finalHeaders.forEach((h, idx) => {
            if (h) row[h] = rowArray[idx];
          });

          // 1. Sanitize and Flexible Match for internal_sku
          let internal_sku_raw = findColumnBySanitizedIncludes(row, '자사상품코드');
          if (internal_sku_raw === undefined) {
            internal_sku_raw = findColumnBySanitizedIncludes(row, '샵플링상품코드');
          }
          // Fallback to existing logic if still undefined
          if (internal_sku_raw === undefined) {
            internal_sku_raw = findColumnValue(row, ['상품코드', '쇼핑몰상품코드', '마켓상품코드', '자사코드', '관리번호', 'internal_sku']);
          }
          const productCode = toStrictStringCode(internal_sku_raw).toUpperCase();

          // 2. Option Code
          const option_code = String(findColumnBySanitizedIncludes(row, '옵션코드') || '').trim().toUpperCase();

          // [Task] Accurate extraction of order_option (Handling "옵션상세 (수정불가)")
          const order_option = String(
            findColumnBySanitizedIncludes(row, '옵션상세') || 
            findColumnBySanitizedIncludes(row, '주문옵션') || 
            findColumnValue(row, ['옵션', '주문옵션', '품목명']) || 
            ''
          ).trim();

          const option_barcode = String(findColumnBySanitizedIncludes(row, '옵션바코드') || findColumnValue(row, ['바코드', '옵션바코드']) || '').trim().toUpperCase();

          // 3. Unit Price
          const unit_price = Number(findColumnBySanitizedIncludes(row, '공급가') || findColumnValue(row, ['매입가', '공급가', '원가', '매입단가', '단가'])) || 0;

          // 4. Record Date
          let record_date_raw = findColumnBySanitizedIncludes(row, '수정일');
          if (record_date_raw === undefined) {
            record_date_raw = findColumnBySanitizedIncludes(row, '날짜');
          }
          if (record_date_raw === undefined) {
            record_date_raw = findColumnValue(row, ['수집일자', '등록일', 'date', 'collected_at']);
          }
          const record_date = formatToISO(record_date_raw);

          // Other fields
          const supplier = String(findColumnValue(row, ['매입처', '공급사', '제조사', 'vendor_name'])).trim() || '-';
          const trackingNumber = String(findColumnValue(row, ['송장번호', '운송장번호', 'tracking_number']) || '').trim();
          const orderNo = String(findColumnValue(row, ['주문번호', '공급사주문번호', 'order_no']) || '').trim();
          const shippingFee = Number(findColumnValue(row, ['배송비', 'shipping_fee'])) || 0;
          const productName = String(findColumnValue(row, ['상품명', '주문상품명', 'product_name']) || '').trim();
          const courier = String(findColumnValue(row, ['택배사', '택배사명', 'courier']) || '').trim();
          
          return {
            ...row, // Include original headers for backend mapping
            internal_sku: productCode,
            option_code,
            order_option,
            options: order_option,
            option_barcode,
            unit_price,
            record_date,
            product_name: productName,
            courier: courier,
            
            // UI compatibility
            productCode,
            purchasePrice: unit_price,
            supplier,
            trackingNumber,
            orderNo,
            shippingFee,
            productName,
            collectedAt: record_date,
            source
          };
        });

        // 3. Silent Failure Prevention
        const hasValidData = normalized.some(item => item.internal_sku);
        if (!hasValidData) {
          throw new Error("엑셀에서 상품코드 헤더를 인식할 수 없습니다. 양식을 확인해주세요.");
        }
        
        resolve(normalized);
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = (error) => reject(error);
    reader.readAsBinaryString(file);
  });
};

const HEADER_ALIASES = {
  vendor_order_id: ['공급사ID', '주문번호', '주문코드', '주문번호+출고그룹', '전표번호', '주문관리번호', '공급사주문번호', '주문고유코드'],
  product_name: ['상품명', '주문상품명', '상품이름', '판매상품명', '주문 상품명', '품명', '상품', '명칭', 'Name'],
  unit_price: ['공급가(원)', '공급가', '상품비', '결제금액', '총결제금액', '가격', '단가', '상품금액', '공급가액', '매입가', '종결결제금액', '매입단가'],
  shipping_fee: ['배송비', '총배송비', '결제배송비', '배송료', '배송금액', '운임비', '배송비(원)'],
  internal_sku: ['자사상품코드', '상품번호', '상품코드', '주문상품코드', '관리코드', '자사코드', '관리번호'],
  order_option: ['옵션상세', '상품주문옵션', '주문옵션', '옵션', '상세옵션', '선택사항', '선택', 'Option'],
  option_barcode: ['바코드', '옵션바코드', 'Barcode']
};

export const parseUnifiedPurchaseExcel = (file: File): Promise<any[]> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: 'binary' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const rows: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

        if (rows.length === 0) throw new Error('엑셀 파일에 데이터가 없습니다.');

        // 1. Find header row
        let headerRowIndex = -1;
        for (let i = 0; i < Math.min(rows.length, 10); i++) {
          const row = rows[i];
          if (row.some(cell => {
            const s = String(cell || '').replace(/\s/g, '');
            return Object.values(HEADER_ALIASES).flat().some(alias => alias.replace(/\s/g, '') === s);
          })) {
            headerRowIndex = i;
            break;
          }
        }
        if (headerRowIndex === -1) headerRowIndex = 0;

        const rawHeaders = rows[headerRowIndex].map(h => String(h || '').trim());
        const dataRows = rows.slice(headerRowIndex + 1);

        const normalized = dataRows.filter(rowArray => rowArray.length > 0).flatMap((rowArray) => {
          // 1. Normalize Headers (Remove newlines, spaces, and '(수정불가)')
          const cleanHeader = (h: string) => h ? String(h).replace(/[\r\n\s]+/g, '').replace(/\(수정불가\)/g, '') : '';
          
          const row: any = {};
          rawHeaders.forEach((h, idx) => { 
            if (h) {
              const cleaned = cleanHeader(h);
              row[cleaned] = rowArray[idx]; 
            }
          });

          const findVal = (keys: string[]) => {
            for (const key of keys) {
              const sanitizedKey = key.replace(/[\r\n\s]+/g, '').toLowerCase();
              const actualKey = Object.keys(row).find(k => k.toLowerCase() === sanitizedKey);
              if (actualKey && row[actualKey] !== undefined) return row[actualKey];
            }
            return undefined;
          };

          const vendor_order_id = String(findVal(HEADER_ALIASES.vendor_order_id) || '').trim();
          const record_date_raw = findColumnValue(row, ['출고일자', '출고일', '주문일자', '주문일시', '결제일시', '날짜', '등록일', '수정일', '수집일자']);
          
          let pName = String(findVal(HEADER_ALIASES.product_name) || '').trim();
          let pOptionRaw = String(findVal(HEADER_ALIASES.order_option) || '').trim();

          // [Normalization] 사입 엑셀 줄바꿈 처리 (상품명\r\n옵션 형태 분리)
          if (pName.match(/[\r\n]/) && !pOptionRaw) {
            const parts = pName.split(/[\r\n]+/);
            pName = parts[0].trim();
            pOptionRaw = parts.slice(1).join('\n').trim();
          }

          // [Requirement 1] 다중 옵션 줄바꿈 분리 (flatMap 활용)
          const optionLines = pOptionRaw ? pOptionRaw.split(/[\r\n]+/).filter(l => l.trim()) : [''];
          const baseUnitPrice = Number(findVal(HEADER_ALIASES.unit_price)) || 0;
          const baseQuantity = Number(findColumnValue(row, ['수량', '주문수량', '결제수량', '판매수량'])) || 1;
          const baseShippingFee = parseShippingFee(findVal(HEADER_ALIASES.shipping_fee)) || 0;
          let internal_sku = String(findVal(HEADER_ALIASES.internal_sku) || '').trim();
          const option_barcode = String(findColumnValue(row, ['바코드', '옵션바코드', 'Barcode']) || '').trim().toUpperCase();

          // [Normalization] 공급사별 코드 정제 로직
          let normalized_sku = internal_sku.replace(/^(OLC_|WDM_|W_)/, '');
          if (/^[A-Z]{1,2}\d+$/.test(normalized_sku)) {
            normalized_sku = normalized_sku.replace(/[^0-9]/g, '');
          }

          return optionLines.map((line, idx) => {
            let order_option = line.trim();
            let unit_price = baseUnitPrice;
            let quantity = baseQuantity;
            let is_unit_price = false;

            // [Requirement 2 & 3] 정규식(Regex) 기반 옵션명, 수량, 금액 정밀 추출 및 단가 재계산
            const domaemeRegex = /(.+?)\s*\((\d+)개\)\s*([\d,]+)원/;
            const match = line.match(domaemeRegex);
            if (match) {
              order_option = match[1].trim();
              quantity = parseInt(match[2], 10) || 1;
              const totalPrice = parseInt(match[3].replace(/,/g, ''), 10) || 0;
              // [Absolute Force Formula] unit_price = Number(추출된 총액) / Number(추출된 옵션수량)
              unit_price = quantity > 0 ? totalPrice / quantity : totalPrice;
              is_unit_price = true;
            }

            // Distribute shipping fee only to the first split to maintain cost integrity
            const shipping_fee = idx === 0 ? baseShippingFee : 0;

            return {
              vendor_order_id,
              record_date: formatToISO(record_date_raw),
              product_name: pName,
              unit_price,
              quantity,
              shipping_fee,
              internal_sku: normalized_sku,
              order_option,
              option_barcode,
              rawRow: row,
              is_unit_price,
              // UI compatibility
              productCode: normalized_sku,
              purchasePrice: unit_price,
              shippingFee: shipping_fee,
              productName: pName,
              collectedAt: formatToISO(record_date_raw)
            };
          });
        });

        resolve(normalized);
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = (error) => reject(error);
    reader.readAsBinaryString(file);
  });
};

// ============================================================================
// [HEADER OFFSET DETECTOR FOR AD PERFORMANCE ANALYSIS]
// 스마트스토어, 지마켓, 11번가 등 마켓별로 헤더 상단에 임의의 타이틀 정보가
// 삽입되어 있는 레이아웃 오프셋(Offset) 불일치 문제를 해결하기 위한 스캐너입니다.
// 상위 15개 행을 타겟팅하여 광고 연관 핵심 컬럼을 매치해 헤더 인덱스를 동적으로 찾아냅니다.
// ============================================================================
const findHeaderRowIndex = (sheet: any, XLSX: any): number => {
  try {
    // 시트의 데이터를 2D 배열 형태로 가볍게 추출
    const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, range: 0 });
    
    // 스마트스토어, 지마켓, 11번가 등의 오프셋 불일치를 완전 사멸할 헤더 지표 후보군
    const headerIndicators = [
      '일별', '날짜', '날짜별', '기간', 'date', 'report_date',
      '노출', '노출수', 'impressions',
      '클릭', '클릭수', 'clicks',
      '비용', '총비용', '소진비용', '광고비', 'cost',
      '구매수', '전환수', 'conversions',
      '구매금액', '전환금액', 'conversion_revenue',
      '캠페인', '광고그룹', '요일별', '시간대별', '평균선택', '평균cpc', '평균노출순위'
    ];

    let bestIdx = 0;
    let maxScore = 0;

    // 상위 15행 내에서 모든 행에 대해 점수 산출
    for (let i = 0; i < Math.min(rawData.length, 15); i++) {
      const row = rawData[i];
      if (!row || !Array.isArray(row)) continue;
      
      let score = 0;
      row.forEach((cell: any) => {
        if (cell === null || cell === undefined) return;
        const cellStr = String(cell).trim().toLowerCase().replace(/[\s_]+/g, '');
        if (cellStr === '') return;

        // 셀 내에 헤더 지표가 단 하나라도 포함되어 있는지 정확히 매칭 검증
        const matched = headerIndicators.some(ind => cellStr === ind || cellStr.includes(ind));
        if (matched) {
          score += 1;
        }
      });

      if (score > maxScore) {
        maxScore = score;
        bestIdx = i;
      }
    }

    // 통계적 매칭 스코어가 최소 2점 이상 확보되었다면 최적 후보행으로 엄격 채택
    if (maxScore >= 2) {
      return bestIdx;
    }
  } catch (error) {
    console.warn("Header detection failed, defaulting to 0", error);
  }
  return 0; // 찾지 못한 경우 기본값(1행) 반환
};

export const parseAdFile = (file: File): Promise<any[]> => {
  return new Promise((resolve, reject) => {
    // 1. 파일명 기반 메타데이터 자동 추출 로직 - 최우선 진실의 공급원 (Primary Source)
    const filename = file.name || '';
    const cleanFileName = filename.replace(/\.[^/.]+$/, "").replace(/\s*\(\d+\)/g, "").trim();
    const parts = cleanFileName.split('_');
    
    const extractedMarket = parts[0]?.trim() || "스마트스토어";
    const extractedAdType = parts[1]?.trim() || "검색광고";
    const extractedAccount = parts.slice(2).join('_').trim() || "알수없음";

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: 'binary' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        if (!worksheet) {
          resolve([]);
          return;
        }

        // 2차원 셀 배열로 시트 전체 데이터 획득 & 동적 헤더 시프트 처리
        const rawRows = XLSX.utils.sheet_to_json<any[]>(worksheet, { header: 1 });
        if (rawRows.length === 0) {
          resolve([]);
          return;
        }

        const headerIdx = findHeaderRowIndex(worksheet, XLSX);
        let headers: string[] = [];
        if (rawRows[headerIdx]) {
          headers = rawRows[headerIdx].map((h: any) => h !== null && h !== undefined ? String(h).trim() : '');
        }

        let jsonData: any[] = [];
        if (headers.length > 0) {
          // 찾은 헤더가 있을 경우, 헤더 행 이후의 데이터를 키-값 객체 맵핑
          for (let i = headerIdx + 1; i < rawRows.length; i++) {
            const row = rawRows[i];
            if (Array.isArray(row) && row.some(cell => cell !== null && cell !== undefined && String(cell).trim() !== '')) {
              const obj: any = {};
              headers.forEach((h, idx) => {
                if (h) {
                  obj[h] = row[idx] !== undefined ? row[idx] : '';
                }
              });
              jsonData.push(obj);
            }
          }
        } else {
          // 일치하는 헤더를 발견하지 못했을 경우의 안전한 폴백 (기존 0번 행 기준 파싱)
          jsonData = XLSX.utils.sheet_to_json(worksheet);
        }
        
        // Helper to sanitize number format (comma, hyphen etc)
        const sanitizeNumber = (val: any): number => {
          if (val === undefined || val === null) return 0;
          const s = String(val).trim();
          if (s === '' || s === '-' || s === '0' || s === '0.00' || s === 'null' || s === 'undefined') return 0;
          
          const cleaned = s.replace(/[^0-9.-]+/g, '');
          if (cleaned === '' || cleaned === '-') return 0;
          
          const num = Number(cleaned);
          return isNaN(num) ? 0 : num;
        };

        const mappedKeysList = [
          '날짜', '날짜별', '일별', '기간', 'Date', 'report_date',
          '노출수', '노출', 'impressions',
          '클릭수', '클릭', 'clicks',
          '총비용', '광고비', '소진비용', '비용', 'cost',
          '구매수', '총 전환수', '광고상품기준-주문수', '구매완료 전환수', '구매완료 수', '전환수', 'conversions',
          '구매금액', '총 전환 금액', '광고상품기준-구매금액', '구매완료 전환매출액(원)', '전환금액', 'conversion_revenue'
        ];
        const mappedKeysSet = new Set(mappedKeysList.map(k => k.toLowerCase().replace(/[\s_]+/g, '')));

        const normalized = jsonData.map((row: any) => {
          // 1. 원본 날짜 값 추출 (Fallback 적용 - any 타입 강제 부여)
          const rawDate: any = row['일별'] || row['날짜'] || row['날짜별'] || row['기간'] || row['report_date'] || findColumnValue(row, ['일별', '날짜', '날짜별', '기간', 'Date', 'report_date']) || '';
          
          // 2. 강력한 타입 가드를 가미한 강제 문자열 또는 일련번호 정밀 정제 (이중 래핑 및 any 타입 우회)
          let formattedDate = '';
          if (rawDate) {
            if (typeof rawDate === 'number') {
              const ms = Math.round(rawDate * 86400000);
              const d = dayjs.utc('1899-12-30').add(ms, 'ms');
              formattedDate = d.format('YYYY-MM-DD');
            } else {
              formattedDate = String(rawDate || '')
                .replace(/\./g, '-') // 마침표를 하이픈으로
                .replace(/-+$/, '')  // 끝에 남은 하이픈 제거
                .trim();             // 공백 제거
            }
          }

          let report_date = '';
          if (formattedDate) {
            const parsed = dayjs(formattedDate);
            if (parsed.isValid()) {
              report_date = parsed.format('YYYY-MM-DD');
            }
          }

          // Maximize mapping synonyms with priority on target columns for Korean marketplaces
          const impressions = Math.round(sanitizeNumber(
            row['노출수'] || findColumnValue(row, ['노출수', '노출', 'impressions'])
          ));
          const clicks = Math.round(sanitizeNumber(
            row['클릭수'] || findColumnValue(row, ['클릭수', '클릭', 'clicks'])
          ));
          const cost = sanitizeNumber(
            row['총비용'] || row['비용'] || findColumnValue(row, ['총비용', '비용', '광고비', '소진비용', 'cost'])
          );
          const conversions = Math.round(sanitizeNumber(
            row['구매완료 전환수'] || row['구매완료 수'] || row['총 전환수'] || row['구매수'] || row['광고상품기준-주문수'] || findColumnValue(row, ['구매완료 전환수', '구매완료 수', '총 전환수', '구매수', '광고상품기준-주문수', '전환수', 'conversions'])
          ));
          
          // 1. 광고 유형 식별
          const currentAdType = extractedAdType || row['광고유형'] || row['캠페인유형'] || findColumnValue(row, ['광고유형', '캠페인유형', '광고종류']) || '';
          
          // 2. 조건부 매출액 매핑 (지마켓 AI매출업인 경우 판매자기준-구매금액으로 집계)
          let rawRevenue;
          if (String(currentAdType).includes('AI매출업')) {
            rawRevenue = row['판매자기준-구매금액'] || row['판매자기준-전환매출액'] || findColumnValue(row, ['판매자기준-구매금액', '판매자기준-전환매출액']) || '0';
          } else {
            rawRevenue = row['구매완료 전환매출액(원)'] || row['구매완료 전환매출액'] || row['총 전환 금액'] || row['구매금액'] || row['광고상품기준-구매금액'] || findColumnValue(row, ['구매완료 전환매출액(원)', '구매완료 전환매출액', '총 전환 금액', '구매금액', '광고상품기준-구매금액', '전환금액', 'conversion_revenue']) || '0';
          }
          const conversion_revenue = sanitizeNumber(rawRevenue);

          // 3. 신규 컬럼 파싱 (평균CPC, 평균노출순위, 요일, 시간대별)
          const dateObj = new Date(report_date);
          const days = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
          const day_of_week = (report_date && !isNaN(dateObj.getTime())) ? days[dateObj.getDay()] : null;

          const average_cpc = Number(String(row['평균 클릭비용'] || row['평균클릭비용'] || row['평균CPC'] || row['평균 CPC'] || row['평균클릭비용(VAT포함,원)'] || row['클릭비용'] || '0').replace(/[^0-9.-]+/g, '')) || 0;

          const average_position = Number(String(row['평균 노출순위'] || row['평균노출순위'] || row['노출순위'] || row['평균 순위'] || '0').replace(/[^0-9.-]+/g, '')) || 0;

          const time_of_day = row['시간대별'] || row['시간대'] || null;

          // 광고그룹: '광고그룹', '캠페인 이름', '캠페인명', '그룹명' 유연한 맵핑
          const rawAdGroup = row['광고그룹'] || row['캠페인 이름'] || row['캠페인명'] || row['그룹명'] || findColumnValue(row, ['광고그룹', '캠페인 이름', '캠페인명', '그룹명']) || '';
          const ad_group = String(rawAdGroup).trim();

          // 비고: '비고', '메모', '설명', '상세' 유연한 맵핑
          const rawDesc = row['비고'] || row['메모'] || row['설명'] || row['상세'] || findColumnValue(row, ['비고', '메모', '설명', '상세']) || '';
          const description = String(rawDesc).trim();

          // 클릭률 유연한 맵핑 (클릭률, 클릭률(%) 모두 지원)
          const click_rate = sanitizeNumber(
            row['클릭률'] || row['클릭률(%)'] || findColumnValue(row, ['클릭률', '클릭률(%)', 'ctr', 'CTR'])
          );
          
          // Isolate raw_metrics
          const raw_metrics: Record<string, any> = {};
          Object.entries(row).forEach(([k, v]) => {
            const normKey = k.toLowerCase().replace(/[\s_]+/g, '');
            if (!mappedKeysSet.has(normKey)) {
              raw_metrics[k] = v;
            }
          });

          return {
            market: extractedMarket,
            ad_type: extractedAdType,
            account: extractedAccount,
            report_date,
            impressions,
            clicks,
            cost,
            conversions,
            conversion_revenue,
            day_of_week,
            average_cpc,
            average_position,
            time_of_day,
            click_rate,
            ad_group,
            description,
            raw_metrics,
            // Keep keys for old application state compatibility just in case
            date: report_date,
            adSpend: cost,
            roas: cost > 0 ? (conversion_revenue / cost) * 100 : 0
          };
        });
        
        // 유효하지 않거나 빈 날짜(Empty/Invalid Date) 행을 완벽하게 2차 드랍 처리
        const cleanAdRows = normalized.filter((item: any) => {
          return item.report_date && item.report_date !== 'Invalid Date' && dayjs(item.report_date).isValid();
        });

        resolve(cleanAdRows);
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = (error) => reject(error);
    reader.readAsBinaryString(file);
  });
};
