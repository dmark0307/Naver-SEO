import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const url = process.env.VITE_SUPABASE_URL || '';
const key = process.env.VITE_SUPABASE_ANON_KEY || '';

const supabase = createClient(url, key);

async function checkColumns() {
  const extractedKeyword = "테스트키워드";
  
  const baseDataToSave = {
    keyword: extractedKeyword.trim(),
    keyword_1: "테스트1",
    keyword_2: "테스트2",
    keyword_3: "테스트3",
    array_fixed_score: ["조합1:5", "조합2:10"],
    position_score: ["위치1:2"],
    product_name_score: ["상품명1:3"],
    area_value_order: ["[속성] 테스트#테스트", "[태그] 선반#선반"],
    representative_category: "대표카테고리테스트",
    total_search_count: 500,
    product_count: 10000,
    competition_rate: 1.25,
    keyword_value_order: ["가치1", "가치2"],
    category_terms: ["카테고리텀1", "카테고리텀2"],
    product_details_array: [{ ranking: 1, product_name: "가구" }],
    updated_at: new Date().toISOString()
  };

  // 1. Insert Test
  console.log('1. Trying INSERT...');
  const { data: insertData, error: insertError } = await supabase
    .from('search_csv_keywords')
    .insert([baseDataToSave])
    .select();

  if (insertError) {
    console.log('INSERT FAILED:', insertError);
  } else {
    console.log('INSERT SUCCESS:', insertData);
  }

  // 2. Update Test
  console.log('2. Trying UPDATE...');
  const updatePayload = { ...baseDataToSave };
  delete updatePayload.keyword;

  const { data: updateData, error: updateError } = await supabase
    .from('search_csv_keywords')
    .update(updatePayload)
    .eq('keyword', extractedKeyword.trim())
    .select();

  if (updateError) {
    console.log('UPDATE FAILED:', updateError);
  } else {
    console.log('UPDATE SUCCESS:', updateData);
  }

  // Cleanup
  console.log('3. Cleaning up...');
  const { error: deleteError } = await supabase
    .from('search_csv_keywords')
    .delete()
    .eq('keyword', extractedKeyword.trim());
  
  if (deleteError) {
    console.log('Cleanup failed:', deleteError);
  } else {
    console.log('Cleanup success!');
  }
}

checkColumns();
