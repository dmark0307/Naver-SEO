const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf-8');

// 바꿀 기존 fetch 블록 (인덴트나 개행 문자에 구애받지 않도록 정규표현식으로 타겟팅)
const targetRegex = /\/\/ \[연관\(XLSX\) 대표 카테고리 백엔드 동기화 엔진 호출\][\s\S]*?\}\s*catch\s*\(syncErr[\s\S]*?\}\s*\}\s*catch\s*\(syncErr[\s\S]*?\}/;

// 더 포괄적인 정규표현식으로 시도해봅시다.
const targetRegex2 = /\/\/ \[연관\(XLSX\) 대표 카테고리 백엔드 동기화 엔진 호출\][\s\S]*?console\.error\("\[Client\] XLSX Category Sync network\/exception error caught:", syncErr\);\s*\}/;

const replacement = `// =========================================================================
          // ① [1단계: 클라이언트 단 파일 전체 기준 최빈 카테고리(Dominant Category) 산출]
          // =========================================================================
          const categoryCounts = {};
          processedKeywords.forEach((k) => {
            const cat = (k.representative_category || '').trim();
            if (cat) {
              categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
            }
          });

          let dominantCategory = '';
          let maxCount = 0;
          Object.entries(categoryCounts).forEach(([cat, count]) => {
            if (count > maxCount) {
              maxCount = count;
              dominantCategory = cat;
            }
          });

          if (!dominantCategory && fallbackCatVal) {
            dominantCategory = fallbackCatVal;
          }

          console.log('[SUCCESS] Dominant Category:', dominantCategory);

          // =========================================================================
          // ② [2단계: 프론트엔드 인메모리 1:1 키워드 매핑 및 페이로드 조립]
          // =========================================================================
          const cleanedXlsxKeys = new Set();
          processedKeywords.forEach((k) => {
            const rawKw = k.keyword || '';
            if (rawKw) {
              const kwFullyCleaned = rawKw.replace(/\\s*\\(\\d+\\)/g, '').replace(/\\s+/g, '').toLowerCase();
              cleanedXlsxKeys.add(kwFullyCleaned);
            }
          });

          // =========================================================================
          // ③ [3단계: Supabase Client Direct 1:1 타겟 업데이트 발송]
          // =========================================================================
          try {
            // DB의 모든 키워드를 가져와서 1:1 대조
            const { data: allCsvRows, error: fetchError } = await supabase
              .from('search_csv_keywords')
              .select('id, keyword');

            if (fetchError) {
              console.error("[Client] Failed to fetch search_csv_keywords for matching:", fetchError);
            } else if (allCsvRows) {
              let pinpointUpdatedCount = 0;
              for (const row of allCsvRows) {
                const rawDbKeyword = String(row.keyword || '');
                if (!rawDbKeyword) continue;

                const dbKwCleaned = rawDbKeyword.replace(/\\s*\\(\\d+\\)/g, '').replace(/\\s+/g, '').toLowerCase();

                if (cleanedXlsxKeys.has(dbKwCleaned)) {
                  const sanitizedKeyword = row.keyword;
                  try {
                    // [가드 1 & 2]: 'WHERE keyword = sanitizedKeyword' 조건의 1:1 단일 대상 업데이트(Single-Row Target Update) 강제 체결.
                    // category_base, position_score, array_fixed_score, product_name_score, product_details_array 등은 페이로드에서 아예 완전 누락(Omit).
                    const { error: singleUpdateError } = await supabase
                      .from('search_csv_keywords')
                      .update({
                        representative_category: dominantCategory || null,
                        updated_at: new Date().toISOString()
                      })
                      .eq('keyword', sanitizedKeyword);

                    if (singleUpdateError) {
                      console.error("[Client Sync Pinpoint] DB update failed for keyword \\"" + sanitizedKeyword + "\\":", singleUpdateError);
                    } else {
                      pinpointUpdatedCount++;
                    }
                  } catch (singleRowErr) {
                    console.error("[Client Sync Exception] Pinpoint single row failure for \\"" + sanitizedKeyword + "\\":", singleRowErr);
                  }
                }
              }
              console.log("[Client Sync] Completed Pinpoint 1:1 Single-Row Updates. Success Count: " + pinpointUpdatedCount);
            }
          } catch (clientSyncErr) {
            console.error("[Client Sync] Exception during pinpoint matching update process:", clientSyncErr);
          }`;

let replaced = false;
if (targetRegex2.test(content)) {
  content = content.replace(targetRegex2, replacement);
  replaced = true;
} else if (targetRegex.test(content)) {
  content = content.replace(targetRegex, replacement);
  replaced = true;
}

if (replaced) {
  fs.writeFileSync('src/App.tsx', content, 'utf-8');
  console.log("Successfully replaced the sync code block in src/App.tsx");
} else {
  console.log("Regex patterns did not match! Printing excerpt around the search area...");
  const searchIndex = content.indexOf('// [연관(XLSX) 대표 카테고리 백엔드 동기화 엔진 호출]');
  if (searchIndex !== -1) {
    console.log(content.substring(searchIndex, searchIndex + 1000));
  } else {
    console.log("Keyword comment not found at all.");
  }
}
