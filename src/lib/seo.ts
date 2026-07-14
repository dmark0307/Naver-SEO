import { read, utils } from 'xlsx';
import Papa from 'papaparse';
import { GoogleGenAI } from "@google/genai";

// Types
export interface ProductData {
  [key: string]: any;
}

export interface AnalysisResult {
  fixedKeywords: string[];
  autoKeywords: { word: string; count: number }[];
  specCounts: { word: string; count: number }[];
  tags: { tag: string; count: number }[];
  rejectedTags?: { tag: string; count: number }[];
  generatedTitle: string;
  metrics: {
    charLength: number;
    byteLength: number;
    keywordCount: number;
  };
  statsKeywords: any[];
  displayStatsKeyword?: string;
  rawTopKeyword?: string;
  excludedKeywords?: string[];
  oldName: string;
}

// Constants
const EXCLUDE_BRANDS = [
  '매일', '서울우유', '서울', '연세', '남양', '건국', '파스퇴르', '일동', '후디스',
  '소와나무', '빙그레', '셀로몬', '빅원더', '미광스토어', '데어리마켓', '도남상회',
  '희창유업', '담터', '연세유업', '매일유업', '오공', '우드픽스'
];

// Helper Functions
const getByteLength = (s: string) => {
  let b = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    b += (c >> 7) ? 2 : 1;
  }
  return b;
};

export class SEOManager {
  private df: ProductData[];
  private excludeBrands: string[];
  private genAI: GoogleGenAI;

  constructor(
    df: ProductData[] = [], 
    userExcludeList: string[] = [], 
    excludeShops: string[] = [], 
    analysisLimit?: number
  ) {
    this.excludeBrands = [...EXCLUDE_BRANDS, ...userExcludeList];
    
    // [1단계] 설정된 제외쇼핑몰을 우선적으로 찾아서 해당행(row)을 삭제 (필터링)
    let filteredDf = [...df];
    if (excludeShops && excludeShops.length > 0) {
      const cleanExcludeShops = excludeShops.map(s => s.trim().toLowerCase()).filter(Boolean);
      filteredDf = filteredDf.filter(row => {
        // [필터 영역 제한 규칙]: 오직 업로드된 엑셀 데이터 구조에서 매핑된 '쇼핑몰' 헤더 열 또는 데이터 객체의 쇼핑몰 명칭 필드 값만 비교
        const mallName = String(
          row['쇼핑몰'] || 
          row['쇼핑몰명'] || 
          row['마켓명'] || 
          row['마켓'] || 
          row['Mall'] || 
          row['Channel'] || 
          row['mall_name'] || 
          ''
        ).trim().toLowerCase();
        
        // 해당 쇼핑몰 필드에 제외 대상 쇼핑몰명이 포함되어 있는 경우만 제외(삭제)
        const hasExcludedShop = cleanExcludeShops.some(shop => mallName.includes(shop));
        return !hasExcludedShop;
      });
    }

    // [2단계] 설정된 행갯수(analysisLimit) 이상의 행을 삭제 (슬라이싱)
    if (analysisLimit && analysisLimit > 0) {
      filteredDf = filteredDf.slice(0, analysisLimit);
    }

    this.df = filteredDf;
    
    // Initialize Gemini API with import.meta.env.VITE_GEMINI_API_KEY
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY || '';
    this.genAI = new GoogleGenAI({ apiKey });
  }

  // Generate Strategic Keywords using Gemini
  public async generateStrategicKeywords(
    mainKeyword: string, 
    category: string, 
    excludedWords: string[]
  ): Promise<string[]> {
    try {
      const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
      if (!apiKey) {
        console.warn("Gemini API Key is missing");
        return [];
      }

      const prompt = `
        너는 네이버 쇼핑 SEO 전문가야.
        
        [상품 정보]
        - 메인 키워드: ${mainKeyword}
        - 카테고리: ${category}
        
        [제외할 단어들]
        ${excludedWords.join(', ')}
        
        [요청사항]
        위 상품 정보와 제외 단어를 고려하여, 구매 전환율을 높일 수 있는 **독창적이고 차별화된 전략 키워드 3개**를 추천해줘.
        
        [제약조건]
        1. 반드시 **1단어(명사)**여야 해. (예: '가성비', '신혼부부', '캠핑용')
        2. 이미 '제외할 단어들'에 포함된 단어는 절대 사용하지 마.
        3. 결과는 반드시 JSON 문자열 배열 형태 ["단어1", "단어2", "단어3"]으로만 대답해. 설명은 필요 없어.
      `;

      const result = await this.genAI.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt
      });
      
      const responseText = result.text || "";
      const jsonMatch = responseText.match(/\[.*\]/s);
      
      if (jsonMatch) {
        const jsonString = jsonMatch[0];
        const tokens = JSON.parse(jsonString);
        if (Array.isArray(tokens)) {
          return tokens.map(t => String(t).trim()).filter(t => t.length > 0).slice(0, 3);
        }
      }
      return [];
    } catch (e) {
      console.error("Strategic Keyword Generation Failed", e);
      return [];
    }
  }

  // Basic splitter for bulk operations (Sync) - No static list dependency
  private splitBaseTerms(text: any, isManual = false, keepAll = false): string[] {
    const str = String(text || "").trim();
    if (!str || str === '-' || str.toLowerCase() === 'null') return [];
    
    // NLU Spacing Logic: Character type transitions
    // English/Number + Korean -> Space, Korean + English/Number -> Space
    // Also English + Number -> Space
    const nluText = SEOManager.applyNLUSpacing(str);

    // Remove special chars but keep spaces and alphanumeric/hangul
    const cleanText = nluText.replace(/[^가-힣a-zA-Z0-9\s]/g, ' ');
    const rawWords = cleanText.split(/\s+/);
    const terms: string[] = [];
    
    for (const word of rawWords) {
      const trimmed = word.trim();
      if (!trimmed || trimmed.toLowerCase() === 'null') continue;
      
      if (!keepAll) {
        const isBrand = this.excludeBrands.some(b => b.toLowerCase() === trimmed.toLowerCase());
        if (isBrand) continue;
        
        // Exclude simple numbers (only digits)
        if (!isManual && /^\d+$/.test(trimmed)) continue;
      }
      
      terms.push(trimmed);
    }
    return terms;
  }

  /**
   * NLUTERMS-based Word Splitting Logic (Strict)
   * Splits by character type transitions and specific suffixes.
   */
  public static splitByNluTerms(text: string): string[] {
    if (!text) return [];
    
    // 1. Apply NLUSpacing (Character type transitions)
    const spaced = SEOManager.applyNLUSpacing(text);
    
    // 2. Split by spaces and non-alphanumeric characters
    const rawParts = spaced.split(/[^가-힣a-zA-Z0-9]+/).filter(p => p.length > 0);
    
    const result = new Set<string>();
    // 지정 접미사 리스트: 막이, 용품, 기기, 커버, 가구, 장식, 소품, 모형, 세트, 도구
    const NLU_SPLIT_SUFFIXES = ['막이', '용품', '기기', '커버', '가구', '장식', '소품', '모형', '세트', '도구'];
    
    rawParts.forEach(part => {
      result.add(part); // Always add the original part
      
      // [접두사(2글자 이상)] + [지정된 접미사] 형태일 때만 분리한다.
      for (const suffix of NLU_SPLIT_SUFFIXES) {
        if (part.endsWith(suffix) && part.length > suffix.length) {
          const prefix = part.slice(0, -suffix.length);
          if (prefix.length >= 2) {
            // Split into prefix and suffix
            // e.g., "창문막이" -> "창문", "막이"
            result.add(prefix);
            result.add(suffix);
          }
        }
      }
    });
    return Array.from(result);
  }

  /**
   * Applies spacing based on character type transitions.
   * Ensures 1-character keywords (English, Number, Hangul) are independent.
   * Zero-Exception: All previous compound split exceptions are removed.
   */
  public static applyNLUSpacing(text: string): string {
    if (!text) return '';
    
    // [Task] 유형 분리 로직 제거 (Disable Type-based Splitting)
    // 한글, 영문, 숫자 간의 경계에서 무조건적으로 단어를 분리하던 기존 규칙을 삭제한다.
    // 기존에는 "하우스D" -> "하우스 D", "1개" -> "1 개"와 같이 분리했으나, 
    // 이제는 붙어있는 경우 하나의 토큰으로 유지한다.
    
    return text.replace(/\s+/g, ' ').trim();
  }

  /**
   * [ARCHITECTURAL SEPARATION]
   * Decoupled extractor for "Performance Keywords" (Source: Order History Matrix)
   * Aggregates inflow/revenue and returns the top performer.
   */
  public async extractPerformanceKeywords(statsDf: any[]): Promise<{
    topKeywords: { keyword: string; inflow: number; revenue: number; rank: number }[],
    mainPerformanceKw: string
  }> {
    if (!statsDf || statsDf.length === 0) return { topKeywords: [], mainPerformanceKw: "" };

    const kwMap = new Map<string, { keyword: string; inflow: number; revenue: number; rank: number }>();
    
    // Performance Header Mapping (Hardened for new Excel format)
    const kwColNames = ['상품명', '검색어', '키워드', 'Keyword'];
    const inflowColNames = ['결제수(과거 14일간 기여도추정)', '클릭수', '유입수', 'Inflow'];
    const revenueColNames = ['결제금액(과거 14일간 기여도추정)', '결제금액', '매출액', 'Revenue'];

    statsDf.forEach(row => {
      const keys = Object.keys(row);
      const kwKey = keys.find(k => kwColNames.includes(k)) || '키워드';
      const infKey = keys.find(k => inflowColNames.includes(k)) || '클릭수';
      const revKey = keys.find(k => revenueColNames.includes(k)) || '결제금액';
      
      const kw = String(row[kwKey] || '').trim();
      if (!kw || kw === '-' || kw.toLowerCase() === 'null') return;

      const inf = Number(String(row[infKey] || '0').replace(/[^0-9.]/g, '')) || 0;
      const rev = Number(String(row[revKey] || '0').replace(/[^0-9.]/g, '')) || 0;
      const rank = Number(row['순위'] || row['평균순위'] || 0) || 0;

      if (kwMap.has(kw)) {
        const existing = kwMap.get(kw)!;
        existing.inflow += inf;
        existing.revenue += rev;
      } else {
        kwMap.set(kw, { keyword: kw, inflow: inf, revenue: rev, rank });
      }
    });

    const sorted = Array.from(kwMap.values()).sort((a, b) => b.inflow - a.inflow || b.revenue - a.revenue);
    
    return {
      topKeywords: sorted,
      mainPerformanceKw: sorted.length > 0 ? sorted[0].keyword : ""
    };
  }

  public async extractStatsData(statsDf: ProductData[], targetCode: string): Promise<{ 
    keywords: string[], 
    oldName: string, 
    displayStatsKeyword: string,
    rawTopKeyword: string,
    excludedKeywords: string[],
    topKeywords: { keyword: string; inflow: number; rank: number }[],
    debugInfo?: any
  }> {
    try {
      if (!statsDf || statsDf.length === 0) return { keywords: [], oldName: "", displayStatsKeyword: "", rawTopKeyword: "", excludedKeywords: [], topKeywords: [], debugInfo: { error: "Empty Data" } };

      // Find columns dynamically with regex for flexibility
      const keys = Object.keys(statsDf[0]);
      
      const findCol = (patterns: RegExp[]) => {
        for (const pattern of patterns) {
          const found = keys.find(k => pattern.test(k));
          if (found) return found;
        }
        return undefined;
      };

      // Priority: Exact/Common names first
      const codeCol = findCol([/상품ID/, /상품코드/, /상품번호/, /물품코드/, /단품코드/, /코드/, /ID/, /번호/, /Code/i, /No\./i, /ProductCode/i]);
      const kwCol = findCol([/키워드/, /Keyword/i, /Search Term/i]);
      const nameCol = findCol([/상품명/, /상품이름/, /제품명/, /Name/i, /Product/i]);
      
      // New Columns for Inflow and Rank
      const inflowCol = findCol([/유입수/, /평균 클릭수/, /클릭수/, /Inflow/i, /Click/i, /유입/, /Visit/i]);
      const rankCol = findCol([/평균노출순위/, /평균순위/, /노출순위/, /Rank/i, /순위/, /노출/, /Position/i]);
      const dupCol = findCol([/중복횟수/, /중복/, /Count/i, /Dup/i]);
      const revenueCol = findCol([/결제금액/, /매출액/, /매출/, /Revenue/i, /Amount/i, /Sales/i]);

      const debugInfo = {
        totalRows: statsDf.length,
        columns: keys,
        detectedCols: { codeCol, kwCol, nameCol, inflowCol, rankCol, dupCol, revenueCol },
        targetCode,
        matchCount: 0
      };

      if (!codeCol || !kwCol || !nameCol) {
        return { keywords: [], oldName: "", displayStatsKeyword: "", rawTopKeyword: "", excludedKeywords: [], topKeywords: [], debugInfo: { ...debugInfo, error: "Column Missing" } };
      }

      // Helper for robust number parsing (Regex Clean)
      const parseNum = (val: any) => {
        if (!val) return 0;
        // Remove everything except digits and dots
        const str = String(val).replace(/[^0-9.]/g, '');
        if (!str) return 0;
        const num = parseFloat(str);
        return isNaN(num) ? 0 : num;
      };

      // Filter by target code ONLY (Ignore Product Name Match)
      // Robust matching: String conversion + trim
      const targetCodeStr = String(targetCode).trim();
      let filtered = statsDf.filter(row => String(row[codeCol]).trim() === targetCodeStr);
      
      // Filter by Inflow > 0 if column exists
      if (inflowCol) {
        filtered = filtered.filter(row => {
           const val = parseNum(row[inflowCol]);
           return val > 0;
        });
      }

      debugInfo.matchCount = filtered.length;

      if (filtered.length === 0) {
        // Try to find a sample code to show in debug
        const sampleCode = statsDf.length > 0 ? String(statsDf[0][codeCol]) : "None";
        return { keywords: [], oldName: "", displayStatsKeyword: "", rawTopKeyword: "", excludedKeywords: [], topKeywords: [], debugInfo: { ...debugInfo, error: "Target Code Not Found or No Inflow", sampleCode } };
      }

      const existingName = filtered[0][nameCol] ? String(filtered[0][nameCol]) : "";

      // Sort by 4-step logic: Inflow (Desc) -> Revenue (Desc) -> Rank (Asc) -> Duplicate (Desc)
      let sortedRows = filtered;
      sortedRows = filtered.sort((a, b) => {
        // 1. Inflow (Desc)
        const inflowA = inflowCol ? parseNum(a[inflowCol]) : 0;
        const inflowB = inflowCol ? parseNum(b[inflowCol]) : 0;
        if (inflowA !== inflowB) return inflowB - inflowA;

        // 2. Revenue (Desc)
        const revA = revenueCol ? parseNum(a[revenueCol]) : 0;
        const revB = revenueCol ? parseNum(b[revenueCol]) : 0;
        if (revA !== revB) return revB - revA;

        // 3. Rank (Asc) - Lower is better
        // If rank is missing or 0, treat as very low priority (high number)
        const getRankPriority = (val: any) => {
          const num = parseNum(val);
          return (num && num > 0) ? num : 999;
        };
        const rankA = rankCol ? getRankPriority(a[rankCol]) : 999;
        const rankB = rankCol ? getRankPriority(b[rankCol]) : 999;
        if (rankA !== rankB) return rankA - rankB;

        // 4. Duplicate Count (Desc)
        const dupA = dupCol ? parseNum(a[dupCol]) : 0;
        const dupB = dupCol ? parseNum(b[dupCol]) : 0;
        return dupB - dupA;
      });

      // Extract Top Keywords List (ALL keywords with inflow > 0, NO filtering)
      const topKeywords = sortedRows.map(row => ({
        keyword: (row[kwCol] && String(row[kwCol]).trim() !== 'null') ? String(row[kwCol]).trim() : "",
        inflow: inflowCol ? parseNum(row[inflowCol]) : 0,
        revenue: revenueCol ? parseNum(row[revenueCol]) : 0,
        rank: rankCol ? parseNum(row[rankCol]) : 0
      })).filter(k => k.keyword && k.keyword !== '-' && k.keyword.toLowerCase() !== 'null');

      // Select top 1 keyword (Main Keyword Selection Logic)
      // Skip brands/excluded words if possible
      let topKeyword = "";
      
      // 1. Try to find first non-brand keyword
      for (const row of sortedRows) {
        const kw = String(row[kwCol] || "").trim();
        if (!kw || kw === '-' || kw.toLowerCase() === 'null') continue;

        const hasBrand = this.excludeBrands.some(brand => kw.includes(brand));
        if (!hasBrand) {
          topKeyword = kw;
          break;
        }
      }

      // 2. Fallback: If all are brands, take the 1st one (highest inflow)
      if (!topKeyword && sortedRows.length > 0) {
         const firstRow = sortedRows.find(r => r[kwCol] && String(r[kwCol]).trim() !== '-' && String(r[kwCol]).trim().toLowerCase() !== 'null');
         if (firstRow) topKeyword = String(firstRow[kwCol]);
      }

      // Collect excluded keywords (for display in "Excluded" section, purely informational now)
      const excludedSet = new Set<string>();
      sortedRows.forEach(row => {
        const kw = String(row[kwCol] || "").trim();
        if (kw && kw !== '-' && kw.toLowerCase() !== 'null' && kw !== topKeyword) {
          excludedSet.add(kw);
        }
      });
      const excludedKeywords = Array.from(excludedSet);

      if (!topKeyword) return { keywords: [], oldName: existingName, displayStatsKeyword: "", rawTopKeyword: "", excludedKeywords: [], topKeywords: [], debugInfo: { ...debugInfo, error: "No Valid Keyword" } };

      // [Optimization] Use simple split instead of Gemini NLU
      const extracted = this.splitBaseTerms(topKeyword, true);
      
      // Reconstruct rawTopKeyword with spaces for display/usage
      const decomposedTopKeyword = extracted.join(' ');
      
      // Dual Keyword System
      const displayStatsKeyword = extracted.length >= 3 
        ? extracted.slice(0, 2).join(' ') 
        : extracted.join(' ');

      return { 
        keywords: extracted, 
        oldName: existingName, 
        displayStatsKeyword, 
        rawTopKeyword: decomposedTopKeyword,
        excludedKeywords,
        topKeywords,
        debugInfo: { ...debugInfo, success: true }
      };

    } catch (e) {
      console.error("Error extracting stats data", e);
      return { keywords: [], oldName: "", displayStatsKeyword: "", rawTopKeyword: "", excludedKeywords: [], topKeywords: [], debugInfo: { error: "Exception", details: String(e) } };
    }
  }

  private reorderForReadability(wordCountPairs: {word: string, count: number}[]) {
    const identity = ['전지', '분유', '우유', '탈지'];
    const form = ['분말', '가루', '스틱', '액상'];
    const usage = ['자판기', '업소용', '대용량', '식자재'];
    const desc = ['진한', '고소한', '맛있는', '추억'];

    const getPriority = (word: string) => {
      if (identity.some(core => word.includes(core))) return 1;
      if (form.some(core => word.includes(core))) return 2;
      if (usage.some(core => word.includes(core))) return 3;
      if (desc.some(core => word.includes(core))) return 4;
      return 5;
    };

    return [...wordCountPairs].sort((a, b) => getPriority(a.word) - getPriority(b.word));
  }

  /**
   * 전역 레벨 태그 및 키워드 정규화 헬퍼 함수
   * [CRITICAL] 한글, 영문, 숫자만 남기고 모든 공백 및 특수문자를 제거하는 화이트리스트 방식 적용
   */
  public static normalizeTag(tag: any): string {
    if (!tag) return "";
    const pureString = typeof tag === 'object' ? (tag.keyword || tag.name || String(tag)) : String(tag);
    // 한글, 영문(대소문자), 숫자 외의 모든 문자(특수기호, 공백, 보이지 않는 캐릭터 등) 완벽 제거 후 소문자화
    return pureString.replace(/[^a-zA-Z0-9가-힣]/g, '').toLowerCase();
  }

  /**
   * [CRITICAL] 마스터 빈도수 사전(Master Dictionary) 구축
   * 전체 로드된 원본 데이터를 기반으로 태그 및 키워드의 전역 빈도수를 계산합니다.
   * 콤마(,)로 구분된 다중 태그를 완벽하게 분리하여 정확한 카운트를 보장합니다.
   */
  public getGlobalKeywordCounts(): {[key: string]: number} {
    const masterMap: {[key: string]: number} = {};
    
    if (!this.df || this.df.length === 0) return masterMap;

    const allKeys = Object.keys(this.df[0]);
    const findCol = (patterns: RegExp[]) => {
      return allKeys.find(k => patterns.some(p => p.test(k)));
    };
    
    // [CRITICAL] 카운트 범위를 오직 '검색인식태그' 필드로 엄격하게 제한
    const tagCol = findCol([/검색인식태그/, /태그/, /Tag/i]);

    this.df.forEach(row => {
      // 검색인식태그 데이터 처리 (콤마 분리 및 개별 정규화)
      if (tagCol && row[tagCol] && String(row[tagCol]).trim() !== '') {
        const rawTags = String(row[tagCol]);
        rawTags.split(',').forEach(rawTag => {
          const normalized = SEOManager.normalizeTag(rawTag);
          if (normalized) {
            masterMap[normalized] = (masterMap[normalized] || 0) + 1;
          }
        });
      }
    });

    return masterMap;
  }

  private isComposedOfExistingWords(tag: string, wordSet: Set<string>): boolean {
    if (!tag) return false;
    const lowerTag = tag.toLowerCase();
    
    // 1. Exact match in the word set
    if (wordSet.has(lowerTag)) return true;

    // 2. Word-unit deduplication (Zero-Exception)
    // Split the tag into words using our standard splitting rules
    const words = this.splitBaseTerms(lowerTag, true, true);
    
    if (words.length === 0) return false;

    // If ALL words in the tag are already present in the wordSet, 
    // it means this tag adds NO new information.
    return words.every(word => wordSet.has(word.toLowerCase()));
  }

  public runAnalysis(
    statsKeywords: any, 
    conversionInput: string, 
    addInput: string, 
    totalTargetCount: number,
    displayStatsKeyword?: string,
    rawTopKeyword?: string,
    excludedKeywords?: string[],
    excludedByUser: string[] = [],
    manualMainKeyword?: string,
    excludedTags: string[] = [],
    forcedTags: string[] = [],
    mainKeywordPosition: number = 7,
    existingAutoKeywords?: {word: string, count: number}[],
    manualTitle: string = '',
    strategicKeyword: string | null = null,
    statsData: any[] = []
  ): AnalysisResult {
    // 1. Decompose inputs
    // Main Keywords (Source: conversionInput - as per UI mapping)
    // Prompt calls this "Main Keyword", mapped to conversionInput in UI
    // [Task] Isolation Logic: Extract Main Keywords first
    const mainTokens = this.splitBaseTerms(conversionInput, true);
    const mainSet = new Set(mainTokens.map(t => t.toLowerCase()));

    // Strategic Keywords
    let strategicTokens = (strategicKeyword && !excludedByUser.includes(strategicKeyword)) 
      ? this.splitBaseTerms(strategicKeyword, true) 
      : [];
    // Dedupe strategic against Main
    strategicTokens = strategicTokens.filter(t => !mainSet.has(t.toLowerCase()));
    const strategicSet = new Set(strategicTokens.map(t => t.toLowerCase()));

    // Performance Keywords (Source: manualMainKeyword or statsKeywords)
    let perfTokens: string[] = [];
    let statsKeywordsResult: any[] = [];

    if (manualMainKeyword && manualMainKeyword.trim().length > 0) {
      perfTokens = manualMainKeyword.trim().split(/\s+/);
      // If we have statsKeywords as objects, try to match and preserve data
      if (Array.isArray(statsKeywords)) {
        statsKeywordsResult = perfTokens.map(tk => {
          const matched = statsKeywords.find(sk => 
            (typeof sk === 'object' && (sk.keyword === tk || sk.키워드 === tk)) ||
            (typeof sk === 'string' && sk === tk)
          );
          return typeof matched === 'object' ? matched : { keyword: tk, inflow: 0, revenue: 0 };
        });
      } else {
        statsKeywordsResult = perfTokens.map(k => ({ keyword: k, inflow: 0, revenue: 0 }));
      }
    } else if (Array.isArray(statsKeywords) && statsKeywords.length > 0) {
      // [Task] Sort Performance Keywords: Inflow (Desc) > Revenue (Desc)
      const sorted = [...statsKeywords].sort((a, b) => {
        const infA = typeof a === 'object' ? (Number(a.inflow) || 0) : 0;
        const infB = typeof b === 'object' ? (Number(b.inflow) || 0) : 0;
        if (infB !== infA) return infB - infA;
        
        const revA = typeof a === 'object' ? (Number(a.revenue) || 0) : 0;
        const revB = typeof b === 'object' ? (Number(b.revenue) || 0) : 0;
        return revB - revA;
      });
      statsKeywordsResult = sorted;
      perfTokens = sorted.map(k => typeof k === 'object' ? (k.keyword || k.키워드 || '') : String(k)).filter(Boolean);
    } else if (typeof statsKeywords === 'string' && statsKeywords.trim().length > 0) {
      // Fallback for comma-separated string if passed directly
      perfTokens = statsKeywords.split(',').map(k => k.trim()).filter(Boolean);
      statsKeywordsResult = perfTokens.map(k => ({ keyword: k, inflow: 0, revenue: 0 }));
    } else {
      // Fallback
      if (this.df.length > 0 && this.df[0]['상품명']) {
        const firstProductName = String(this.df[0]['상품명']);
        const terms = this.splitBaseTerms(firstProductName);
        perfTokens = terms.slice(0, 2);
        statsKeywordsResult = perfTokens.map(k => ({ keyword: k, inflow: 0, revenue: 0 }));
      }
    }
    // Dedupe perf against Strategic (Main is excluded from dedupe as per Task)
    // Handle string comparison safely
    perfTokens = perfTokens.filter(t => !strategicSet.has(String(t).toLowerCase()));

    // Fixed Keywords (Source: addInput)
    let fixedTokens = this.splitBaseTerms(addInput, true);
    // Dedupe fixed against Main, Strategic, and Perf
    const perfSet = new Set(perfTokens.map(t => t.toLowerCase()));
    fixedTokens = fixedTokens.filter(t => 
      !mainSet.has(t.toLowerCase()) && 
      !strategicSet.has(t.toLowerCase()) && 
      !perfSet.has(t.toLowerCase())
    );

    // 2. Setup Deduplication Context for Auto Keywords
    const seenTokens = new Set<string>();
    mainTokens.forEach(t => seenTokens.add(t.toLowerCase()));
    strategicTokens.forEach(t => seenTokens.add(t.toLowerCase()));
    perfTokens.forEach(t => seenTokens.add(t.toLowerCase()));
    fixedTokens.forEach(t => seenTokens.add(t.toLowerCase()));

    // 3. Auto Extract from Product Names
    let selectedAuto: {word: string, count: number}[] = [];
    let autoKeywordsList: {word: string, count: number}[] = [];

    if (existingAutoKeywords && existingAutoKeywords.length > 0) {
      // Use existing keywords from DB as Single Source of Truth
      selectedAuto = existingAutoKeywords;
      autoKeywordsList = existingAutoKeywords;
    } else {
      const nameTerms: string[] = [];
      
      // Combine productData (this.df) and statsData (competition/stats) for broader keyword discovery
      const combinedDf = [...this.df, ...statsData];
      
      combinedDf.forEach(row => {
        // Look for product names in common columns
        const rowName = row['상품명'] || row['상품이름'] || row['제품명'] || row['Name'] || row['Product'];
        if (rowName) {
          nameTerms.push(...this.splitBaseTerms(rowName));
        }
        
        // Also look for keywords in stats columns if available
        const rowKw = row['키워드'] || row['검색어'] || row['유입어'];
        if (rowKw) {
          nameTerms.push(...this.splitBaseTerms(rowKw));
        }

        // Also look for tags
        const rowTags = row['검색인식태그'] || row['태그'] || row['Tag'];
        if (rowTags) {
          String(rowTags).split(',').forEach(tag => {
             nameTerms.push(...this.splitBaseTerms(tag.trim()));
          });
        }
      });

      // Count frequencies
      const nameFreq: {[key: string]: number} = {};
      nameTerms.forEach(t => nameFreq[t] = (nameFreq[t] || 0) + 1);
      
      const sortedNameFreq = Object.entries(nameFreq)
        .sort(([,a], [,b]) => b - a)
        .map(([word, count]) => ({word, count}));

      // Filter Auto Candidates
      // Remove if in seenTokens (Perf, Main, Fixed) or User Excluded
      const autoCandidates = sortedNameFreq.filter(item => !seenTokens.has(item.word) && !excludedByUser.includes(item.word));

      // Refined Frequency Count (Substring check)
      const topCandidates = autoCandidates.slice(0, 200);
      const refinedCandidates = topCandidates.map(item => {
        const keyword = item.word;
        const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'i');
        let realCount = 0;
        for (const row of this.df) {
          const pName = String(row['상품명'] || '');
          if (regex.test(pName)) realCount++;
        }
        return { word: keyword, count: realCount };
      });

      refinedCandidates.sort((a, b) => b.count - a.count);
      autoKeywordsList = refinedCandidates;

      // Select Auto Keywords
      // We need enough auto keywords to fill the gap
      // Total needed = totalTargetCount - (Strategic + Perf + Fixed + Main)
      const currentCount = strategicTokens.length + perfTokens.length + fixedTokens.length + mainTokens.length;
      const remainCount = Math.max(0, totalTargetCount - currentCount);
      
      selectedAuto = refinedCandidates.slice(0, remainCount);
    }

    const readableAutoPairs = this.reorderForReadability(selectedAuto);
    const autoTokens = readableAutoPairs.map(p => p.word);

    // Add auto keywords to seenTokens for global deduplication context (for Tag Analysis)
    readableAutoPairs.forEach(p => seenTokens.add(p.word));

    // Section 2: Spec Analysis (Full Frequency Investigation)
    const specFreq: {[key: string]: number} = {};
    const allKeys = this.df.length > 0 ? Object.keys(this.df[0]) : [];
    
    // Dynamic Column Detection
    const findCol = (patterns: RegExp[]) => {
      return allKeys.find(k => patterns.some(p => p.test(k)));
    };
    
    const nameCol = findCol([/상품명/, /상품이름/, /제품명/, /Name/i, /Product/i]) || '상품명';
    const specCol = findCol([/스펙/, /속성/, /Attribute/i, /Spec/i, /필터/]);

    this.df.forEach(row => {
      // 1. Collect keywords from Name
      if (row[nameCol]) {
        const words = SEOManager.splitByNluTerms(String(row[nameCol]));
        words.forEach(word => {
          const trimmed = word.trim();
          if (trimmed.length >= 2 && !this.excludeBrands.includes(trimmed) && !/^\d+$/.test(trimmed)) {
            specFreq[trimmed] = (specFreq[trimmed] || 0) + 1;
          }
        });
      }
      
      // 2. Collect keywords from Spec column if it exists
      if (specCol && row[specCol]) {
        const specVal = String(row[specCol]);
        // Split by common delimiters
        const parts = specVal.split(/\||,|\//);
        parts.forEach(p => {
          const words = SEOManager.splitByNluTerms(p);
          words.forEach(word => {
            const trimmed = word.trim();
            if (trimmed.length >= 2 && !this.excludeBrands.includes(trimmed) && !/^\d+$/.test(trimmed)) {
              specFreq[trimmed] = (specFreq[trimmed] || 0) + 1;
            }
          });
        });
      }
    });

    const specCounts = Object.entries(specFreq)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 40)
      .map(([word, count]) => ({word, count}));

    // Build precise title keywords set for tag deduplication (case-insensitive, keep all words)
    // S_ref: Hybrid splitting (Space + NLU)
    const titleKeywords = new Set<string>();
    
    // If manualTitle is provided, use it as the primary source for title keywords
    const baseTitleSource = manualTitle || [...perfTokens, ...mainTokens, ...fixedTokens, ...autoTokens].join(' ');
    
    // 1. Space-based split + 2. NLU-based split
    const sRefTokens = SEOManager.splitByNluTerms(baseTitleSource);
    sRefTokens.forEach(token => {
      titleKeywords.add(token.toLowerCase());
    });

    const allTitleComponents = manualTitle 
      ? [manualTitle] 
      : [...perfTokens, ...mainTokens, ...fixedTokens, ...autoTokens];

    // Section 3: Tag Analysis
    const tagRawList: string[] = [];
    this.df.forEach(row => {
      if (row['검색인식태그'] && row['검색인식태그'] !== '-') {
        const tags = String(row['검색인식태그']).split(',').map(t => t.trim()).filter(t => t);
        tagRawList.push(...tags);
      }
    });

    const tagFreq: {[key: string]: number} = {};
    tagRawList.forEach(t => tagFreq[t] = (tagFreq[t] || 0) + 1);
    
    // 1. Prepare and Sort Candidates (Length-First Strategy)
    const tagCandidates = Object.entries(tagFreq)
      .map(([tag, count]) => ({tag, count}))
      .filter((item) => {
        const tRaw = item.tag;
        if (tRaw.includes('반품') || tRaw.includes('교환')) return false;
        if (excludedTags.includes(tRaw)) return false;
        if (this.excludeBrands.some(b => tRaw.includes(b)) || /\d/.test(tRaw)) return false;
        const subTerms = this.splitBaseTerms(tRaw);
        if (subTerms.length === 0) return false;
        return true;
      })
      .sort((a, b) => {
        // 1순위: 텍스트 전체 글자 수(Length) 내림차순 (가장 구체적인 정보 우선)
        if (b.tag.length !== a.tag.length) return b.tag.length - a.tag.length;
        // 2순위: 빈도수(Count) 내림차순
        return b.count - a.count;
      });

    const finalTags: {tag: string, count: number}[] = [];
    const rejectedTags: {tag: string, count: number}[] = [];
    const cumulativeWordSet = new Set<string>();

    // 1.5 Handle Forced Tags (Bypass all filters, place at top)
    const forcedTagSet = new Set(forcedTags);
    const forcedFinalTags: {tag: string, count: number}[] = [];
    
    forcedTags.forEach(t => {
      const count = tagFreq[t] || 0;
      forcedFinalTags.push({ tag: t, count });
      // Add words to cumulative set to prevent AI from picking redundant tags
      SEOManager.splitByNluTerms(t).forEach(w => cumulativeWordSet.add(w.toLowerCase()));
    });
    // Sort forced tags by count among themselves for better UX
    forcedFinalTags.sort((a, b) => b.count - a.count);
    finalTags.push(...forcedFinalTags);

    // Filter candidates to exclude forced tags and excluded tags
    const filteredCandidates = tagCandidates.filter(item => !forcedTagSet.has(item.tag));

    // Helper: Check if a word can be fully decomposed into forbidden words
    const isCombinationOf = (word: string, forbiddenSet: Set<string>): boolean => {
      if (forbiddenSet.has(word)) return true;
      if (word.length < 2) return false;

      // Try to split the word into two parts, both of which are "known"
      // This is a simple 1-level decomposition which covers most SEO cases like "바람차단"
      for (let i = 2; i <= word.length - 2; i++) {
        const left = word.slice(0, i);
        const right = word.slice(i);
        if (forbiddenSet.has(left) && forbiddenSet.has(right)) {
          return true;
        }
      }
      return false;
    };

    // Helper: Check if a tag is a substring of any existing strings (inclusion check)
    const isSubsumed = (candidate: string, existingStrings: string[]) => {
      const normalizedCandidate = candidate.replace(/\s+/g, '').toLowerCase();
      if (!normalizedCandidate) return false;
      return existingStrings.some(existing => {
        const normalizedExisting = existing.replace(/\s+/g, '').toLowerCase();
        // One-way check: is candidate a substring of existing?
        // This ensures '차량커버' is rejected if '차량전체커버' is present.
        return normalizedExisting.includes(normalizedCandidate);
      });
    };

    // 2. Strict Selection Loop (Single Pass, Length-First)
    for (const item of filteredCandidates) {
      const tRaw = item.tag;
      
      // A. Inclusion Check: 이미 선별된 태그나 상품명에 포함되는지 확인
      const existingSelectedStrings = [
        ...allTitleComponents,
        ...finalTags.map(t => t.tag)
      ];
      
      const redundant = isSubsumed(tRaw, existingSelectedStrings);

      // B. Atomic Novelty Check: 진짜 새로운 단어가 최소 1개 이상 있는지 확인
      // Decompose tag using NLU logic
      const itemWords = SEOManager.splitByNluTerms(tRaw).map(w => w.toLowerCase());
      const combinedForbiddenSet = new Set([...titleKeywords, ...cumulativeWordSet]);
      
      let hasNewWord = false;
      for (const word of itemWords) {
        // A word is "new" if it's not in the forbidden set AND not a simple combination of forbidden words
        if (!isCombinationOf(word, combinedForbiddenSet)) {
          hasNewWord = true;
          break;
        }
      }

      // Selection logic:
      // - Must not be redundant (Inclusion Check)
      // - Must have new word (Atomic Novelty Check)
      
      const passesInclusion = !redundant;
      const passesNovelty = hasNewWord; 

      if (passesInclusion && passesNovelty && finalTags.length < 10) {
        finalTags.push(item);
        // Add all decomposed words to cumulative set
        itemWords.forEach(w => cumulativeWordSet.add(w));
      } else {
        // 탈락 사유가 있더라도 후보군에는 노출 (최대 100개)
        if (rejectedTags.length < 100) {
          rejectedTags.push(item);
        }
      }
    }

    // 4. Construct Golden Sequence
    // [지시 1] 5대 키워드 레이어 배치 시퀀스 및 앵커 키워드 고정 배치 가드 구현
    const finalArray: string[] = [];
    const addedSet = new Set<string>();

    // 앵커 키워드 세트 (중복 방지 룩업용)
    const anchorSet = new Set(mainTokens.map(t => t.toLowerCase()));

    // 우선순위 후보 풀 구축: [1. 전략적] -> [2. 성과] -> [3. 고정]
    const priorityCandidates: string[] = [];
    const addToPriority = (token: string) => {
      const lower = token.toLowerCase();
      // 앵커 키워드 및 제외 키워드와 중복 방지
      if (!addedSet.has(lower) && !anchorSet.has(lower) && !excludedByUser.includes(token)) {
        priorityCandidates.push(token);
        addedSet.add(lower);
      }
    };
    
    strategicTokens.forEach(addToPriority);
    perfTokens.forEach(addToPriority);
    fixedTokens.forEach(addToPriority);

    // 앵커 가드: 앞단 5개 영역 채우기 (priorityCandidates가 부족하면 자동 추천 키워드로 수급)
    let autoIdx = 0;
    while (priorityCandidates.length < 5 && autoIdx < autoKeywordsList.length) {
      const cand = autoKeywordsList[autoIdx].word;
      const candLower = cand.toLowerCase();
      if (!addedSet.has(candLower) && !anchorSet.has(candLower) && !excludedByUser.includes(cand)) {
        priorityCandidates.push(cand);
        addedSet.add(candLower);
      }
      autoIdx++;
    }

    const frontPart = priorityCandidates.slice(0, 5);
    const leftOverPriority = priorityCandidates.slice(5);

    // 앵커 키워드 배치
    const anchorPart: string[] = [];
    mainTokens.forEach(t => {
      const lower = t.toLowerCase();
      if (!addedSet.has(lower) && !excludedByUser.includes(t)) {
        anchorPart.push(t);
        addedSet.add(lower);
      }
    });

    // 뒷단 영역 빌드 (5개에 밀려난 것 + 아직 안 쓰인 추천 키워드)
    const backPart = [...leftOverPriority];
    let remainingAutoIdx = 0;

    while ((frontPart.length + anchorPart.length + backPart.length) < totalTargetCount && remainingAutoIdx < autoKeywordsList.length) {
      const cand = autoKeywordsList[remainingAutoIdx].word;
      const candLower = cand.toLowerCase();
      if (!addedSet.has(candLower) && !anchorSet.has(candLower) && !excludedByUser.includes(cand)) {
        backPart.push(cand);
        addedSet.add(candLower);
      }
      remainingAutoIdx++;
    }

    const tempArray = [...frontPart, ...anchorPart, ...backPart];
    const generatedTitle = SEOManager.applyNLUSpacing(tempArray.join(' '));

    // Return results
    return {
      fixedKeywords: fixedTokens,
      autoKeywords: autoKeywordsList,
      specCounts,
      tags: finalTags, // Already ordered: [Forced (sorted by count), AI (sorted by loop priority)]
      rejectedTags: rejectedTags.sort((a, b) => b.count - a.count),
      generatedTitle,
      metrics: {
        charLength: generatedTitle.length,
        byteLength: getByteLength(generatedTitle),
        keywordCount: tempArray.length
      },
      statsKeywords: statsKeywordsResult,
      displayStatsKeyword: manualMainKeyword || displayStatsKeyword || '',
      rawTopKeyword: manualMainKeyword || rawTopKeyword || '',
      excludedKeywords,
      oldName: ""
    };
  }
}

export const parseFile = async (file: File): Promise<ProductData[]> => {
  return new Promise((resolve, reject) => {
    if (file.name.endsWith('.csv')) {
      const parseWithEncoding = (encoding: string) => {
        Papa.parse(file, {
          header: false,
          skipEmptyLines: true,
          encoding: encoding,
          complete: (results) => {
            const rawData = results.data as any[][];
            if (rawData.length === 0) {
              resolve([]);
              return;
            }

            // Find header row in the same way as XLS/XLSX
            let headerRowIndex = 0;
            let foundHeader = false;
            for (let i = 0; i < Math.min(rawData.length, 20); i++) {
              const row = rawData[i];
              if (!row) continue;
              const rowStr = row.join(' ').toLowerCase();
              if ((rowStr.includes('코드') || rowStr.includes('id') || rowStr.includes('code')) && 
                  (rowStr.includes('키워드') || rowStr.includes('keyword'))) {
                headerRowIndex = i;
                foundHeader = true;
                break;
              }
            }

            const headers = rawData[headerRowIndex] || [];
            const cleanedHeaders = headers.map((h: any) => String(h || '').trim().replace(/^\uFEFF/, ''));

            // Check for expected headers to validate encoding (Fallback to UTF-8 if EUC-KR is corrupt)
            const expectedKeywords = ['번호', 'ID', '코드', '키워드', '상품명', '판매수', '결제수', '구매수', '유입', '클릭', '순위', '노출', 'Code', 'Keyword', 'Name', 'Inflow', 'Click', 'Rank'];
            const hasExpectedHeaders = cleanedHeaders.some(k => 
              expectedKeywords.some(expected => k.toLowerCase().includes(expected.toLowerCase()))
            );

            if (!hasExpectedHeaders && encoding === 'EUC-KR') {
              console.warn('EUC-KR parsing failed validation, retrying with UTF-8');
              parseWithEncoding('UTF-8');
              return;
            }

            const result: ProductData[] = [];
            for (let i = headerRowIndex + 1; i < rawData.length; i++) {
              const row = rawData[i];
              if (!row || row.length === 0) continue;
              
              const obj: ProductData = {};
              cleanedHeaders.forEach((header: string, index: number) => {
                if (header) {
                  const val = row[index];
                  // Trim strings and parse numeric values to prevent type differences with XLSX
                  if (typeof val === 'string') {
                    const trimmedVal = val.trim();
                    const numVal = Number(trimmedVal);
                    obj[header] = (!isNaN(numVal) && trimmedVal !== '') ? numVal : trimmedVal;
                  } else {
                    obj[header] = val;
                  }
                }
              });
              result.push(obj);
            }
            resolve(result);
          },
          error: (err) => reject(err)
        });
      };
      
      parseWithEncoding('EUC-KR');
    } else {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = e.target?.result;
          const workbook = read(data, { type: 'binary' });
          const firstSheet = workbook.SheetNames[0];
          
          // Read as array of arrays to find header row
          const rawData = utils.sheet_to_json(workbook.Sheets[firstSheet], { header: 1 }) as any[][];
          
          if (rawData.length === 0) {
            resolve([]);
            return;
          }

          // Find header row
          let headerRowIndex = 0;
          for (let i = 0; i < Math.min(rawData.length, 20); i++) {
            const row = rawData[i];
            const rowStr = row.join(' ').toLowerCase();
            // Check for key columns
            if ((rowStr.includes('코드') || rowStr.includes('id') || rowStr.includes('code')) && 
                (rowStr.includes('키워드') || rowStr.includes('keyword'))) {
              headerRowIndex = i;
              break;
            }
          }

          // Convert to objects using found header row
          const headers = rawData[headerRowIndex];
          const result: ProductData[] = [];
          
          for (let i = headerRowIndex + 1; i < rawData.length; i++) {
            const row = rawData[i];
            if (!row || row.length === 0) continue;
            
            const obj: ProductData = {};
            headers.forEach((header: any, index: number) => {
              if (header) {
                obj[header] = row[index];
              }
            });
            result.push(obj);
          }
          
          resolve(result);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = reject;
      reader.readAsBinaryString(file);
    }
  });
};
