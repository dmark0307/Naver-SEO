
import { SEOManager } from './src/lib/seo';

// Mock data
const mockDf = [{ '상품명': '테스트 상품', '스펙': '스펙1|스펙2', '검색인식태그': '태그1,태그2' }];
const manager = new SEOManager(mockDf);

const statsKeywords = ['통계1', '통계2'];
const conversionInput = '구매1 구매2'; // manualConv
const addInput = '고정1 고정2';       // manualAdd

// Run analysis
const result = manager.runAnalysis(statsKeywords, conversionInput, addInput, 20);

console.log("Generated Title:", result.generatedTitle);
console.log("Fixed Keywords Order:", result.fixedKeywords);

// Expected Order: stats -> add(고정) -> conversion(구매)
// Expected: ['통계1', '통계2', '고정1', '고정2', '구매1', '구매2']
