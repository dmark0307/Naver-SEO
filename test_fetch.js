import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(utc);
dayjs.extend(timezone);

dotenv.config();

const url = process.env.VITE_SUPABASE_URL || '';
const key = process.env.VITE_SUPABASE_ANON_KEY || '';

const supabase = createClient(url, key);

async function testFetchDbData() {
  console.log("Starting testFetchDbData simulation...");

  // 1. shopmine_sales query with loop
  try {
    const thirtyDaysAgo = dayjs().tz('Asia/Seoul').subtract(30, 'day').startOf('day').toISOString();
    console.log("Querying shopmine_sales since:", thirtyDaysAgo);

    const salesList = [];
    let fromSales = 0;
    const salesStep = 1000;
    let hasMoreSales = true;
    
    while (hasMoreSales) {
      console.log(`Fetching shopmine_sales range ${fromSales} to ${fromSales + salesStep - 1}...`);
      const { data, error } = await supabase
        .from('shopmine_sales')
        .select('market_product_id, order_at, sm_sales_count')
        .gte('order_at', thirtyDaysAgo)
        .order('order_unique_code', { ascending: true })
        .range(fromSales, fromSales + salesStep - 1);
      
      if (error) throw error;
      
      if (data && data.length > 0) {
        salesList.push(...data);
        fromSales += salesStep;
        if (data.length < salesStep) {
          hasMoreSales = false;
        }
      } else {
        hasMoreSales = false;
      }
    }
    console.log(`shopmine_sales queried successfully, got ${salesList.length} rows.`);
  } catch (err) {
    console.error("shopmine_sales exception during loop:", err);
  }

  // 2. products query with loop
  try {
    console.log("Querying products table with loop...");
    const allData = [];
    let from = 0;
    const step = 1000;
    let hasMore = true;

    while (hasMore) {
      console.log(`Fetching products range ${from} to ${from + step - 1}...`);
      const { data, error } = await supabase
        .from('products')
        .select('code, date, original_name, final_title, price, cost, margin_rate, category, tags, mall, account, internal_code, updated_at, inflow_keywords, sales_count, top_keyword, total_inflow, avg_exposure_rank, channel_name, stats_period, stats_account, last_exported_at, rank_tracking_url, is_favorite')
        .range(from, from + step - 1);

      if (error) throw error;

      if (data && data.length > 0) {
        allData.push(...data);
        from += step;
        if (data.length < step) hasMore = false;
      } else {
        hasMore = false;
      }
    }
    console.log(`products queried successfully with loop, got ${allData.length} rows.`);
  } catch (err) {
    console.error("products exception during loop:", err);
  }
}

testFetchDbData();
