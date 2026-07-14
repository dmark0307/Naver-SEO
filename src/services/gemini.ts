import { GoogleGenAI } from "@google/genai";

export interface StrategicKeyword {
  category: string;
  keyword: string;
  reason: string;
}

export async function generateStrategicKeywords(
  apiKey: string,
  mainKeyword: string,
  category: string,
  excludedKeywords: string[]
): Promise<StrategicKeyword[]> {
  if (!apiKey) {
    console.warn("Gemini API Key is missing");
    return [];
  }

  const ai = new GoogleGenAI({ apiKey });
    const prompt = `
    You are a marketing expert for Naver Shopping.
    
    Context:
    - Main Keyword: "${mainKeyword}"
    - Category: "${category}"
    - Excluded Words: ${excludedKeywords.join(', ')}

    Task:
    Recommend exactly 3 powerful, single-word marketing keywords (adjectives or nouns) based on these 3 specific perspectives:
    1. Target-specific (e.g., "자취생", "부모님", "1인가구")
    2. Situation/Place-specific (e.g., "캠핑", "좁은집", "층간소음")
    3. Emotion/Performance-specific (e.g., "기분좋은", "딱딱한", "소음없는")
    
    Constraints:
    1. Must be single words.
    2. STRICTLY EXCLUDE any word from the "Excluded Words" list. This is critical.
    3. Do NOT use generic words like "Product", "Item", "Recommendation".
    4. Return ONLY a JSON array of objects. 
    
    Example Output Format:
    [
      { "category": "타겟", "keyword": "자취생", "reason": "1인 가구 타겟" },
      { "category": "상황", "keyword": "캠핑", "reason": "야외 활동 강조" },
      { "category": "감성", "keyword": "감성", "reason": "분위기 연출" }
    ]
    
    Language: Korean.
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: { 
        responseMimeType: "application/json" 
      }
    });
    
    const text = response.text;
    if (!text) return [];
    
    const result = JSON.parse(text);
    if (Array.isArray(result)) {
      return result.map(item => ({
        category: String(item.category || '기타'),
        keyword: String(item.keyword || '').trim(),
        reason: String(item.reason || '')
      })).slice(0, 3);
    }
    return [];
  } catch (e) {
    console.error("Gemini API Error:", e);
    throw e;
  }
}

export async function splitKeywordsByNlu(
  apiKey: string,
  keywords: string[]
): Promise<{[key: string]: string}> {
  if (!apiKey || keywords.length === 0) return {};

  const ai = new GoogleGenAI({ apiKey });
  const prompt = `
    You are a Korean linguistic expert.
    
    Task:
    Split the following Korean compound nouns into their constituent words with spaces.
    This is for SEO optimization (NLUTERMS morphological analysis).
    
    Example:
    - "강화유리문" -> "강화 유리문"
    - "잠금장치" -> "잠금 장치"
    - "도어클로저" -> "도어 클로저"
    
    Keywords to split:
    ${keywords.join('\n')}
    
    Return ONLY a JSON object where the key is the original keyword and the value is the split version.
    
    Example Output:
    {
      "강화유리문": "강화 유리문",
      "잠금장치": "잠금 장치"
    }
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: { 
        responseMimeType: "application/json" 
      }
    });
    
    const text = response.text;
    if (!text) return {};
    
    const result = JSON.parse(text);
    return result;
  } catch (e) {
    console.error("Gemini NLU Split Error:", e);
    return {};
  }
}
