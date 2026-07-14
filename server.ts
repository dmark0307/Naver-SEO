import express from 'express';
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import cron from 'node-cron';
import dayjs from 'dayjs';

dotenv.config();

// Lazy-loaded Supabase Client
let _supabase: any = null;
function getSupabase() {
  if (!_supabase) {
    const url = process.env.VITE_SUPABASE_URL || '';
    const key = process.env.VITE_SUPABASE_ANON_KEY || '';
    
    if (!url || !key) {
      console.error('[CRITICAL] Missing Supabase Env in getSupabase()');
    }
    
    _supabase = createClient(url, key);
  }
  return _supabase;
}

const app = express();
const PORT = 3000;

// 1. 필수 미들웨어 (가장 상단)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// 2. 최상단 로거 (요청 수신 확인)
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url} - Headers: ${JSON.stringify(req.headers)}`);
  next();
});

// ==========================================
// 3. 🚨 API 라우터 정의 및 마운트
// ==========================================
const api = express.Router();

// API 전용 로거
api.use((req, res, next) => {
  console.log(`[API] ${req.method} ${req.path}`);
  next();
});

import { runOwnerclanRPA } from './src/services/rpaService';

// ... (existing code)

// API Route for RPA Ownerclan
api.post('/rpa/ownerclan', async (req, res) => {
  const { targetDate } = req.body;
  const supabase = getSupabase();
  
  const { data: task, error: taskError } = await supabase
    .from('sync_tasks')
    .insert({ 
      task_type: 'RPA_OWNERCLAN', 
      status: 'PROCESSING',
      updated_at: new Date()
    })
    .select()
    .single();

  if (taskError) return res.status(500).json({ error: taskError.message });

  res.status(202).json({ taskId: task.id, message: 'RPA Bot started' });

  // Background execution
  (async () => {
    try {
      const result = await runOwnerclanRPA(supabase, targetDate);
      
      if (result.success) {
        await supabase.from('sync_tasks').update({ 
          status: 'COMPLETED', 
          progress: 100, 
          result: { count: result.count, message: result.message },
          updated_at: new Date() 
        }).eq('id', task.id);
      } else {
        await supabase.from('sync_tasks').update({ 
          status: 'FAILED', 
          error_message: result.error || result.message,
          updated_at: new Date() 
        }).eq('id', task.id);
      }
    } catch (err: any) {
      console.error('[RPA API] Background Error:', err);
      await supabase.from('sync_tasks').update({ 
        status: 'FAILED', 
        error_message: err.message,
        updated_at: new Date() 
      }).eq('id', task.id);
    }
  })();
});

// TEST ROUTE
api.get('/test', async (req, res) => {
  try {
    console.log('[TEST] Hit /api/test - fetching one product');
    const supabase = getSupabase();
    const { data, error } = await supabase.from('products').select('*').limit(1);
    if (error) {
      console.error('[TEST] Error fetching product:', error);
      return res.status(500).json({ error: error.message });
    }
    const keys = data && data[0] ? Object.keys(data[0]) : [];
    const sample = data && data[0] ? data[0] : null;
    console.log('[TEST] Product columns:', keys);
    console.log('[TEST] Product sample:', sample);
    res.json({ message: 'API is working', columns: keys, sample });
  } catch (err: any) {
    console.error('[TEST] Exception:', err);
    res.status(500).json({ error: err.message });
  }
});

// API Route for Async Sales Count Sync
api.post('/sales/sync-async', async (req, res) => {
  const supabase = getSupabase();
  const { data: task, error: taskError } = await supabase
    .from('sync_tasks')
    .insert({ task_type: 'SALES_COUNT_SYNC', status: 'PROCESSING' })
    .select()
    .single();
  if (taskError) return res.status(500).json({ error: taskError.message });
  res.status(202).json({ taskId: task.id, message: 'Sync started in background' });
  (async () => {
    try {
      const { data, error } = await supabase.rpc('fn_sync_product_sales_count');
      if (error) throw error;
      await supabase.from('sync_tasks').update({ status: 'COMPLETED', progress: 100, result: data, updated_at: new Date() }).eq('id', task.id);
    } catch (err: any) {
      console.error('[AsyncSync] Error:', err);
      await supabase.from('sync_tasks').update({ status: 'FAILED', error_message: err.message, updated_at: new Date() }).eq('id', task.id);
    }
  })();
});

// API Route for Async Shopmine Upload & Mapping
api.post('/sales/upload-async', async (req, res) => {
  const { data } = req.body;
  if (!data || !Array.isArray(data)) return res.status(400).json({ error: 'Invalid data' });
  const supabase = getSupabase();
  const { data: task, error: taskError } = await supabase
    .from('sync_tasks')
    .insert({ task_type: 'SHOPMINE_UPLOAD', status: 'PROCESSING' })
    .select()
    .single();
  if (taskError) return res.status(500).json({ error: taskError.message });
  res.status(202).json({ taskId: task.id });
  (async () => {
    try {
      const chunkSize = 100;
      for (let i = 0; i < data.length; i += chunkSize) {
        const chunk = data.slice(i, i + chunkSize);
        const { error } = await supabase.rpc('fn_process_shopmine_mapping', { upload_data: chunk });
        if (error) throw error;
        const progress = Math.round(((i + chunk.length) / data.length) * 100);
        await supabase.from('sync_tasks').update({ progress, updated_at: new Date() }).eq('id', task.id);
        await new Promise(resolve => setTimeout(resolve, 50)); 
      }
      await supabase.from('sync_tasks').update({ status: 'COMPLETED', progress: 100, updated_at: new Date() }).eq('id', task.id);
    } catch (err: any) {
      console.error('[AsyncUpload] Error:', err);
      await supabase.from('sync_tasks').update({ status: 'FAILED', error_message: err.message, updated_at: new Date() }).eq('id', task.id);
    }
  })();
});

// --- Price Monitoring Crawler Logic ---

function extractVendorProductId(urlStr: string, sku: string): string {
  try {
    const url = new URL(urlStr);
    if (url.hostname.includes('domeggook.com') || url.hostname.includes('domemae.com')) {
      const match = url.pathname.match(/\/(\d+)/);
      if (match) return match[1];
    }
    if (url.hostname.includes('ownerclan.com')) {
      const no = url.searchParams.get('no');
      if (no) return no;
    }
    const pathSegments = url.pathname.split('/');
    for (const segment of pathSegments) {
      if (/^\d{5,15}$/.test(segment)) {
        return segment;
      }
    }
    for (const [, value] of url.searchParams.entries()) {
      if (/^\d{5,15}$/.test(value)) {
        return value;
      }
    }
  } catch (e) {
    // Ignore URL parsing errors
  }
  return sku;
}

async function runPriceMonitor() {
  console.log('[PriceMonitor] Starting scheduled crawl at', new Date().toISOString());
  
  try {
    const supabase = getSupabase();
    // 1. Get products list using actual existing database columns
    const { data: rawProducts, error } = await supabase
      .from('products')
      .select('code, rank_tracking_url, original_name, final_title')
      .not('rank_tracking_url', 'is', null);

    if (error) {
      console.error('[PriceMonitor] Failed to fetch products list from DB:', error.message || error);
      return;
    }

    if (!rawProducts || rawProducts.length === 0) {
      console.log('[PriceMonitor] No products found in the database.');
      return;
    }

    // Filter to products that have a non-empty, valid URL, and map them to expected crawler properties
    const products = rawProducts
      .filter(p => p.rank_tracking_url && p.rank_tracking_url.trim() !== '')
      .map(p => {
        const vendor_url = p.rank_tracking_url.trim();
        return {
          code: p.code,
          name: p.final_title || p.original_name || 'Unknown',
          vendor_url: vendor_url,
          vendor_product_id: extractVendorProductId(vendor_url, p.code)
        };
      });

    if (products.length === 0) {
      console.log('[PriceMonitor] No products with a valid tracking URL to monitor.');
      return;
    }

    console.log(`[PriceMonitor] Monitoring ${products.length} products.`);

    const results = [];
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    for (const product of products) {
      try {
        if (!product.vendor_url) continue;

        // Simple URL validation to prevent fetch crashes
        let url;
        try {
          url = new URL(product.vendor_url);
        } catch (e) {
          console.error(`[PriceMonitor] Invalid URL for ${product.code}: ${product.vendor_url}`);
          continue;
        }

        const response = await fetch(url.toString(), {
          headers: { 'User-Agent': userAgent },
          signal: AbortSignal.timeout(10000) // 10s timeout
        });

        if (!response.ok) {
          console.error(`[PriceMonitor] Failed to fetch ${product.vendor_url}: ${response.status}`);
          continue;
        }

        const html = await response.text();
        const $ = cheerio.load(html);

        let currentPrice = 0;
        let isOutOfStock = false;

        if (product.vendor_url.includes('domeggook.com') || product.vendor_url.includes('domemae.com')) {
           const priceText = $('.price_val, .sale_price').first().text() || '';
           currentPrice = parseInt(priceText.replace(/[^0-9]/g, '')) || 0;
           isOutOfStock = $('.soldout_msg, .btn_soldout').length > 0 || html.includes('품절') || html.includes('판매중지');
        } else if (product.vendor_url.includes('ownerclan.com')) {
           const priceText = $('.goods_price').first().text() || '';
           currentPrice = parseInt(priceText.replace(/[^0-9]/g, '')) || 0;
           isOutOfStock = $('.btn_add_cart_disabled').length > 0 || html.includes('품절');
        } else {
           const priceMatch = html.match(/["']price["']\s*:\s*(\d+)/i);
           if (priceMatch) currentPrice = parseInt(priceMatch[1]);
           isOutOfStock = html.includes('품절') || html.includes('Out of Stock') || html.includes('판매중지');
        }

        results.push({
          vendor_product_id: product.vendor_product_id,
          internal_sku: product.code,
          price: currentPrice,
          stock_status: isOutOfStock ? 'OUT_OF_STOCK' : 'IN_STOCK',
          checked_at: new Date().toISOString()
        });

        // Small delay between requests to be polite
        await new Promise(resolve => setTimeout(resolve, 800));
      } catch (err) {
        console.error(`[PriceMonitor] Error crawling ${product.code}:`, err instanceof Error ? err.message : err);
      }
    }

    if (results.length > 0) {
      // 1. Record in monitor table (History) - Use Chunking
      // Since this table or some of its columns might not exist if migrations aren't run, 
      // we wrap it in a try-catch to keep it robust and non-blocking.
      try {
        const monitorChunks = [];
        const chunkSize = 200;
        for (let i = 0; i < results.length; i += chunkSize) {
          monitorChunks.push(results.slice(i, i + chunkSize));
        }

        for (const chunk of monitorChunks) {
          const { error: insertError } = await supabase
            .from('wholesale_price_monitor')
            .insert(chunk);
          if (insertError) {
            console.warn('[PriceMonitor] wholesale_price_monitor insert skipped (requires SQL schema setup):', insertError.message);
            break;
          }
        }
        console.log(`[PriceMonitor] Successfully recorded ${results.length} monitor entries (where supported).`);
      } catch (monitorErr: any) {
        console.warn('[PriceMonitor] Failed history recording to wholesale_price_monitor (ignored):', monitorErr?.message || monitorErr);
      }

      // 2. Smart Sync to purchase_records (Ledger)
      try {
        const skus = results.map(r => r.internal_sku).filter(Boolean);
        const { data: latestRecords, error: fetchError } = await supabase
          .from('purchase_records')
          .select('internal_sku, unit_price, shipping_fee')
          .in('internal_sku', skus)
          .order('record_date', { ascending: false });

        if (fetchError) {
          console.error('[PriceMonitor] Failed to fetch latest purchase records:', fetchError.message);
        } else {
          const latestMap = new Map();
          latestRecords?.forEach(rec => {
            if (!latestMap.has(rec.internal_sku)) {
              latestMap.set(rec.internal_sku, rec);
            }
          });

          const toInsertPurchase = [];
          for (const res of results) {
            const latest = latestMap.get(res.internal_sku);
            const currentPrice = res.price;

            // Only sync if price is valid and has changed or is new
            if (currentPrice > 0 && (!latest || Number(latest.unit_price) !== currentPrice)) {
              const product = products.find(p => p.code === res.internal_sku);
              
              toInsertPurchase.push({
                internal_sku: res.internal_sku,
                unit_price: currentPrice,
                record_date: new Date().toISOString().split('T')[0],
                vendor_name: product?.vendor_url?.includes('domeggook') ? '도매꾹' : 
                             product?.vendor_url?.includes('domemae') ? '도매매' : 
                             product?.vendor_url?.includes('ownerclan') ? '오너클랜' : '기타도매',
                source_type: 'CRAWL_CHANGE',
                product_name: product?.name || 'Unknown',
                shipping_fee: latest ? Number(latest.shipping_fee) : 0
              });
            }
          }

          if (toInsertPurchase.length > 0) {
            // Chunked insert for purchase records sync
            const chunkSize = 200;
            for (let i = 0; i < toInsertPurchase.length; i += chunkSize) {
              const chunk = toInsertPurchase.slice(i, i + chunkSize);
              const { error: purchaseInsertError } = await supabase
                .from('purchase_records')
                .insert(chunk);
              
              if (purchaseInsertError) {
                console.error('[PriceMonitor] Failed to sync chunk to purchase_records:', purchaseInsertError.message);
              }
            }
            console.log(`[PriceMonitor] Synced ${toInsertPurchase.length} price changes to purchase_records.`);
          }
        }
      } catch (syncErr) {
        console.error('[PriceMonitor] Error during sync to purchase_records:', syncErr);
      }
    }

  } catch (err: any) {
    console.error('[PriceMonitor] Critical error in crawler:', err?.message || err);
  }
}

// Schedule: Daily at 02:00
cron.schedule('0 2 * * *', () => {
  runPriceMonitor();
});

/**
 * [SQL Migration] Dashboard Optimization - Supabase RPC
 * Run this SQL in your Supabase SQL Editor to enable high-performance dashboard calculations.
 * 
 * CREATE OR REPLACE FUNCTION get_dashboard_metrics(
 *   p_start_date TIMESTAMP WITH TIME ZONE,
 *   p_end_date TIMESTAMP WITH TIME ZONE,
 *   p_market TEXT DEFAULT '전체',
 *   p_account TEXT DEFAULT '전체'
 * )
 * RETURNS JSON AS $$
 * DECLARE
 *   result JSON;
 * BEGIN
 *   WITH filtered_sales AS (
 *     SELECT *
 *     FROM shopmine_sales
 *     WHERE order_at >= p_start_date AND order_at <= p_end_date
 *     AND (p_market = '전체' OR mall_name = p_market)
 *     AND (p_account = '전체' OR mall_id = p_account)
 *   ),
 *   daily_stats AS (
 *     SELECT 
 *       TO_CHAR(order_at, 'YYYY-MM-DD') as date,
 *       SUM(actual_payment_amount) as revenue,
 *       SUM(quantity) as smSalesCount,
 *       COUNT(*) as orderCount
 *     FROM filtered_sales
 *     GROUP BY 1
 *     ORDER BY 1 DESC
 *   ),
 *   market_stats AS (
 *     SELECT 
 *       mall_name as name,
 *       SUM(actual_payment_amount) as revenue,
 *       COUNT(*) as orderCount
 *     FROM filtered_sales
 *     GROUP BY 1
 *   )
 *   SELECT json_build_object(
 *     'totalRevenue', COALESCE(SUM(actual_payment_amount), 0),
 *     'totalSmSalesCount', COALESCE(SUM(quantity), 0),
 *     'totalOrderCount', COUNT(*),
 *     'dailyStats', (SELECT json_agg(daily_stats) FROM daily_stats),
 *     'marketStats', (SELECT json_agg(market_stats) FROM market_stats)
 *   ) INTO result
 *   FROM filtered_sales;
 *   
 *   RETURN result;
 * END;
 * $$ LANGUAGE plpgsql;
 * 
 * -- [SQL Migration] Price Monitoring Table
 * -- CREATE TABLE IF NOT EXISTS wholesale_price_monitor (
 * --   id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
 * --   vendor_product_id TEXT NOT NULL,
 * --   internal_sku TEXT NOT NULL,
 * --   price INTEGER DEFAULT 0,
 * --   stock_status TEXT DEFAULT 'IN_STOCK',
 * --   checked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
 * --   created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
 * -- );
 * 
 * -- [SQL Migration] RPA & Sync Task Table
 * -- CREATE TABLE IF NOT EXISTS sync_tasks (
 * --   id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
 * --   task_type TEXT NOT NULL,
 * --   status TEXT NOT NULL DEFAULT 'PROCESSING',
 * --   progress INTEGER DEFAULT 0,
 * --   result JSONB,
 * --   error_message TEXT,
 * --   created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
 * --   updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
 * -- );
 * 
 * -- [SQL Migration] Purchase Records Unique Constraint
 * -- ALTER TABLE purchase_records ADD CONSTRAINT unique_vendor_order_id UNIQUE (vendor_order_id);
 */

// API Route for Purchase List
api.get('/purchase/list', async (req, res) => {
  try {
    const { offset = 0, limit = 30, search = '', startDate = '', endDate = '', supplier = '' } = req.query;
    const supabase = getSupabase();
    
    const columns = [
      'id',
      'internal_sku',
      'option_code',
      'unit_price',
      'record_date',
      'created_at',
      'vendor_name',
      'source_type',
      'shipping_fee',
      'product_name',
      'vendor_order_id',
      'order_option',
      'option_barcode'
    ].join(',');

    let query = supabase
      .from('purchase_records')
      .select(columns, { count: 'exact' });

    // 1. Exact Match Filter for Supplier (High selectivity first)
    if (supplier) {
      query = query.eq('vendor_name', String(supplier).trim());
    }

    // 2. Search Term Filter - Restricted to 4 core columns
    if (search) {
      const s = String(search).trim();
      if (s) {
        // Optimized OR filter: [공급사ID, 자사상품코드, 상품명, 옵션바코드]
        query = query.or(`vendor_order_id.ilike.%${s}%,internal_sku.ilike.%${s}%,product_name.ilike.%${s}%,option_barcode.ilike.%${s}%`);
      }
    }

    // 2. Date Range Filter
    if (startDate) {
      query = query.gte('record_date', startDate);
    }
    if (endDate) {
      query = query.lte('record_date', endDate);
    }

    const { data, error, count } = await query
      .order('record_date', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (error) throw error;

    // [Task] Robust Logic: Identify absolute latest record ID per (SKU, Barcode) for 'Change' badge
    const groupsInPage = data?.map(r => ({
      sku: r.internal_sku,
      barcode: r.option_barcode
    })) || [];

    // Deduplicate groups to minimize queries
    const uniqueGroups: { sku: string, barcode: string | null }[] = [];
    const seenGroups = new Set<string>();
    groupsInPage.forEach(g => {
      if (!g.sku) return;
      const key = `${g.sku}|${g.barcode || ''}`;
      if (!seenGroups.has(key)) {
        seenGroups.add(key);
        uniqueGroups.push(g);
      }
    });

    let latestIdMap = new Map<string, { id: string, count: number }>();
    
    if (uniqueGroups.length > 0) {
      // Fetch the absolute latest record ID and total count for each (SKU, Barcode) group in the current page
      const latestPromises = uniqueGroups.map(g => {
        let query = supabase
          .from('purchase_records')
          .select('id', { count: 'exact' })
          .eq('internal_sku', g.sku);
        
        if (g.barcode) {
          query = query.eq('option_barcode', g.barcode);
        } else {
          // If barcode is missing, match records where barcode is null or empty
          query = query.or('option_barcode.is.null,option_barcode.eq.""');
        }
        
        return query
          .order('record_date', { ascending: false })
          .limit(1)
          .maybeSingle();
      });
      
      const latestResults = await Promise.all(latestPromises);
      latestResults.forEach((res, idx) => {
        if (res.error) {
          console.error(`[PurchaseList] Error fetching latest ID for Group ${uniqueGroups[idx].sku}:`, res.error);
        }
        if (res.data) {
          const key = `${uniqueGroups[idx].sku}|${uniqueGroups[idx].barcode || ''}`;
          latestIdMap.set(key, { id: res.data.id, count: res.count || 0 });
        }
      });
    }

    const enrichedData = data?.map(r => {
      const key = `${r.internal_sku}|${r.option_barcode || ''}`;
      const latestInfo = latestIdMap.get(key);
      
      // [Task] Badge Logic: 
      // 1. Must be the absolute latest record in the group
      // 2. The group must have at least 2 records (to be considered a 'change')
      const isLatest = latestInfo ? latestInfo.id === r.id : false;
      const hasHistory = latestInfo ? latestInfo.count > 1 : false;

      return {
        ...r,
        is_latest: isLatest && hasHistory
      };
    });

    // Get absolute total count
    const { count: absoluteTotal, error: countError } = await supabase
      .from('purchase_records')
      .select('*', { count: 'exact', head: true });

    res.json({ data: enrichedData, count, absoluteTotal: absoluteTotal || 0 });
  } catch (err: any) {
    console.error('[PurchaseList] Error:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch purchase records', 
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined 
    });
  }
});

// API Route for Purchase All (Full Download)
api.get('/purchase/all', async (req, res) => {
  try {
    const { search = '', startDate = '', endDate = '', supplier = '' } = req.query;
    const supabase = getSupabase();
    
    const columns = [
      'internal_sku',
      'option_code',
      'unit_price',
      'record_date',
      'vendor_name',
      'source_type',
      'shipping_fee',
      'product_name',
      'vendor_order_id',
      'order_option',
      'option_barcode'
    ].join(',');

    let baseQuery = supabase
      .from('purchase_records')
      .select(columns, { count: 'exact' });

    if (supplier) {
      baseQuery = baseQuery.eq('vendor_name', String(supplier).trim());
    }

    if (search) {
      const s = String(search).trim();
      if (s) {
        baseQuery = baseQuery.or(`vendor_order_id.ilike.%${s}%,internal_sku.ilike.%${s}%,product_name.ilike.%${s}%,tracking_number.ilike.%${s}%`);
      }
    }

    if (startDate) {
      baseQuery = baseQuery.gte('record_date', startDate);
    }
    if (endDate) {
      baseQuery = baseQuery.lte('record_date', endDate);
    }

    // Fetch all data in chunks to bypass Supabase 1000 row limit
    let allData: any[] = [];
    let from = 0;
    const limit = 1000;
    let hasMore = true;

    while (hasMore) {
      const { data, error, count } = await baseQuery
        .order('record_date', { ascending: false })
        .range(from, from + limit - 1);

      if (error) throw error;
      if (data) {
        allData = [...allData, ...data];
        if (data.length < limit || (count !== null && allData.length >= count)) {
          hasMore = false;
        } else {
          from += limit;
        }
      } else {
        hasMore = false;
      }
    }

    res.json({ data: allData });
  } catch (err: any) {
    console.error('[PurchaseAll] Error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch all purchase records', message: err.message });
  }
});

// API Route for Latest Purchase Prices
api.get('/purchase/latest-prices', async (req, res) => {
  try {
    const supabase = getSupabase();
    
    // This query gets the latest record for each internal_sku
    // In Supabase/PostgreSQL, we can use DISTINCT ON
    const { data, error } = await supabase
      .from('purchase_records')
      .select('id, internal_sku, unit_price, shipping_fee, vendor_name, created_at, record_date')
      .order('internal_sku')
      .order('record_date', { ascending: false });
    
    if (error) throw error;

    // Manual distinct since Supabase JS doesn't support DISTINCT ON directly in a simple way sometimes
    // or we can just process it here.
    const latestPrices: Record<string, any> = {};
    data?.forEach(rec => {
      const sku = String(rec.internal_sku || '').trim();
      if (sku && !latestPrices[sku]) {
        latestPrices[sku] = {
          id: rec.id,
          price: rec.unit_price,
          shipping: rec.shipping_fee,
          supplier: rec.vendor_name,
          createdAt: rec.created_at
        };
      }
    });

    res.json(latestPrices);
  } catch (err: any) {
    console.error('[LatestPrices] Error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch latest prices' });
  }
});

// API Route for Purchase Delete
api.delete('/purchase/delete', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Invalid or empty IDs provided' });
    }

    const supabase = getSupabase();
    const { error } = await supabase
      .from('purchase_records')
      .delete()
      .in('id', ids);

    if (error) throw error;
    res.json({ success: true, message: `${ids.length} records deleted successfully` });
  } catch (err: any) {
    console.error('[PurchaseDelete] Error:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to delete purchase records', 
      message: err.message 
    });
  }
});

// API Route for Purchase Upload
api.post('/purchase/upload', async (req, res) => {
  console.log('[UPLOAD] Hit /api/purchase/upload');
  try {
    const bodyString = JSON.stringify(req.body);
    console.log(`[PurchaseUpload] Payload size: ${bodyString.length} bytes`);
    
    if (bodyString.length > 4 * 1024 * 1024) {
      console.warn('[PurchaseUpload] Payload is close to Vercel 4.5MB limit!');
    }

    const payload = req.body?.data;
    
    if (!payload || !Array.isArray(payload)) {
      console.error('[PurchaseUpload] Invalid payload:', req.body);
      return res.status(400).json({ error: 'Invalid payload structure. Expected { data: [...] }' });
    }

    if (payload.length === 0) {
      return res.status(400).json({ error: 'No data provided in payload' });
    }

    const supabase = getSupabase();
    
    // Fetch supplier mappings for auto-mapping
    const { data: mappings, error: mappingError } = await supabase
      .from('supplier_mappings')
      .select('prefix, supplier_name');
    
    const supplierMap = new Map();
    if (mappings) {
      mappings.forEach(m => {
        if (m.prefix && m.supplier_name) {
          supplierMap.set(m.prefix.trim().toUpperCase(), m.supplier_name.trim());
        }
      });
    }

    // 1. Bulk Data Collection & Mapping
    const skus = [...new Set(payload.map(p => p.internal_sku?.toString().trim().toUpperCase()))].filter(Boolean);
    const barcodes = [...new Set(payload.map(p => p.option_barcode?.toString().trim().toUpperCase()))].filter(Boolean);
    
    // [Task 1] Fetch all relevant existing records in one go
    // We fetch by SKU or Barcode to cover all bases
    const { data: existingRecords, error: fetchError } = await supabase
      .from('purchase_records')
      .select('internal_sku, option_code, option_barcode, unit_price, shipping_fee, record_date, created_at')
      .or(`internal_sku.in.(${skus.map(s => `"${s}"`).join(',')}),option_barcode.in.(${barcodes.map(b => `"${b}"`).join(',')})`)
      .order('record_date', { ascending: false });

    if (fetchError) {
      console.error('[PurchaseUpload] Bulk fetch error:', fetchError);
    }

    // Build In-memory Maps for O(1) lookup
    const skuOptionMap = new Map(); // Key: SKU_Option
    const barcodeMap = new Map();    // Key: Barcode (Latest valid price)

    if (existingRecords) {
      existingRecords.forEach(rec => {
        const normalizedSku = rec.internal_sku?.toString().trim().toUpperCase() || '';
        const normalizedOption = rec.option_code?.toString().trim().toUpperCase() || '';
        const skuKey = `${normalizedSku}_${normalizedOption}`;
        
        if (!skuOptionMap.has(skuKey)) {
          skuOptionMap.set(skuKey, rec);
        }
        
        if (rec.option_barcode) {
          const normalizedBarcode = rec.option_barcode.toString().trim().toUpperCase();
          if (Number(rec.unit_price) > 0) {
            if (!barcodeMap.has(normalizedBarcode)) {
              barcodeMap.set(normalizedBarcode, rec);
            }
          }
        }
      });
    }

    // [Task 3] Build Batch Barcode Map (Current payload fallback)
    const batchBarcodeMap = new Map();
    payload.forEach(item => {
      const price = Number(item.unit_price || 0);
      const normalizedBarcode = item.option_barcode?.toString().trim().toUpperCase();
      if (price > 0 && normalizedBarcode) {
        if (!batchBarcodeMap.has(normalizedBarcode)) {
          batchBarcodeMap.set(normalizedBarcode, price);
        }
      }
    });

    // 2. Process Payload with Strict Comparison and Fallback
    const toInsert = [];
    const changedItems = [];

    payload.forEach(item => {
      let currentPrice = Number(item.unit_price || 0);
      const normalizedBarcode = item.option_barcode?.toString().trim().toUpperCase();
      
      // [Task 3: Refined Fallback Logic]
      if (currentPrice === 0 && normalizedBarcode) {
        // (1) Check current batch
        if (batchBarcodeMap.has(normalizedBarcode)) {
          currentPrice = batchBarcodeMap.get(normalizedBarcode);
          item.unit_price = currentPrice;
        } 
        // (2) Check DB bulk map
        else if (barcodeMap.has(normalizedBarcode)) {
          currentPrice = Number(barcodeMap.get(normalizedBarcode).unit_price);
          item.unit_price = currentPrice;
        }
      }

      // Skip if still 0 or invalid
      if (currentPrice === 0 || isNaN(currentPrice)) {
        return; 
      }

      const normalizedSku = item.internal_sku?.toString().trim().toUpperCase() || '';
      const normalizedOption = item.option_code?.toString().trim().toUpperCase() || '';
      const skuKey = `${normalizedSku}_${normalizedOption}`;
      const latest = skuOptionMap.get(skuKey);
      
      const newShipping = Number(item.shippingFee || 0);
      
      let isPriceChanged = true;
      let isShippingChanged = true;

      if (latest) {
        const oldPrice = Number(latest.unit_price);
        const oldShipping = Number(latest.shipping_fee);
        
        // Strict numeric comparison
        isPriceChanged = oldPrice !== currentPrice;
        isShippingChanged = oldShipping !== newShipping;
      }

      if (!latest || isPriceChanged || isShippingChanged) {
        toInsert.push(item);
        changedItems.push({
          sku: item.internal_sku,
          option: item.option_code,
          barcode: item.option_barcode,
          oldPrice: latest ? Number(latest.unit_price) : 0,
          newPrice: currentPrice,
          oldShipping: latest ? Number(latest.shipping_fee) : 0,
          newShipping: newShipping,
          isNew: !latest,
          isChanged: !!latest && (isPriceChanged || isShippingChanged)
        });
      }
    });

    console.log(`[PurchaseUpload] ${payload.length} records received. ${toInsert.length} records to insert (price changed or new).`);

    if (toInsert.length === 0) {
      return res.status(200).json({ 
        success: true, 
        message: 'No price changes detected. All records are up to date.', 
        updatedCount: 0,
        totalProcessed: payload.length,
        changedItems: [] 
      });
    }

    const chunkSize = 300;
    let successCount = 0;

    for (let i = 0; i < toInsert.length; i += chunkSize) {
      const chunk = toInsert.slice(i, i + chunkSize);
      console.log(`[PurchaseUpload] Inserting chunk ${Math.floor(i / chunkSize) + 1} (${chunk.length} records)`);
      
      const { error } = await supabase
        .from('purchase_records')
        .insert(chunk.map(item => {
          // Fuzzy matching for product_name to handle headers like "상품명\n(수정불가)"
          const productNameKey = Object.keys(item).find(key => key.includes('상품명') || key.includes('품목명'));
          const parsedProductName = productNameKey ? item[productNameKey] : (item.product_name || item.productName || null);

          // Determine registration type for badge logic
          // If it's in changedItems and isChanged is true, it's a '변동'
          const changeInfo = changedItems.find(c => c.sku === item.internal_sku && c.option === item.option_code);
          const isChange = changeInfo?.isChanged || false;

          // Auto-map vendor_name based on internal_sku prefix
          const sku = String(item.internal_sku || '').trim().toUpperCase();
          const prefix = sku.substring(0, 3);
          const mappedVendor = supplierMap.get(prefix);
          const finalVendorName = mappedVendor || (item.supplier || item.vendor_name || item['매입처'] || item['공급사'] || 'Unknown').toString().trim();

          return {
            internal_sku: item.internal_sku,
            option_code: item.option_code,
            unit_price: item.unit_price,
            record_date: item.record_date,
            vendor_name: finalVendorName,
            source_type: `${item.source || 'MASTER'}_CHANGE`,
            shipping_fee: item.shippingFee || 0,
            product_name: parsedProductName,
            vendor_order_id: item.orderNo || null,
            order_option: item.order_option || null,
            option_barcode: item.option_barcode || null
          };
        }));

      if (error) {
        console.error('[DB ERROR] Insert Error (Chunk):', error.message, error.details);
        throw error;
      }
      successCount += chunk.length;
    }

    res.status(200).json({ 
      success: true, 
      message: 'Successfully uploaded purchase records', 
      updatedCount: successCount,
      totalProcessed: payload.length,
      changedItems: changedItems
    });
  } catch (err: any) {
    console.error('[DB ERROR] Missing Column Info (Critical):', err.message, err.details || '');
    res.status(500).json({ 
      success: false,
      error: 'Failed to upload purchase records', 
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
      code: err.code
    });
  }
});

// API to trigger price monitor manually
api.post('/price-monitor/trigger', async (req, res) => {
  runPriceMonitor(); // Run in background
  res.json({ message: 'Price monitor triggered successfully' });
});

// API for Alerts
api.get('/price-alerts', async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('vw_price_alerts')
      .select('*');

    if (error) throw error;
    res.json(data);
  } catch (err: any) {
    console.error('Error fetching alerts:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch alerts',
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// ==========================================
// 🚨 연도별 실적 분석 및 대시보드 연동용 초고속 백그라운드 캐시 엔진 (압도적인 타임아웃 방지 비동기 빌드 및 스캔량 최적화 구조)
// ==========================================
interface UserCacheEntry {
  aggregatedData: any[];
  latestCreatedAt: string | null;
  lastUpdated: number;
  isLoading: boolean;
}

const authUserCacheMap = new Map<string, UserCacheEntry>();

// 연도별 2개년(2025, 2026) 핵심 트리를 추출하기 위해 조회 날짜 강제 바운딩 (디비 스캔 용량 95% 절약)
const LOWER_DATE_LIMIT = '2025-01-01';
const UPPER_DATE_LIMIT = '2026-12-31';

let globalYearlyAdSummaryCache: any[] = [];
let isGlobalCacheLoading = false;
let globalCacheLatestCreatedAt: string | null = null;
let globalCacheLastUpdated = 0;

// PostgreSQL 타임아웃을 감지하고, 실패할 시 자동으로 범위를 2등분으로 쪼개서 성공할 때까지 안전하게 부분 로드하는 자가치유형 슬라이서 함수
async function fetchRangeWithDynamicSlicing(start: string, end: string, step: number = 1000, depth: number = 0): Promise<any[]> {
  const supabase = getSupabase();
  const results: any[] = [];
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    let success = false;
    let lastError: any = null;

    // 최대 3회 재시도 (Exponential Backoff 적용)
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { data, error } = await supabase
          .from('ad_performance_logs')
          .select('id, market, ad_type, account, report_date, impressions, clicks, cost, conversions, conversion_revenue, ad_group')
          .gte('report_date', start)
          .lte('report_date', end)
          .range(from, from + step - 1);

        if (error) {
          throw error;
        }

        if (data) {
          results.push(...data);
          if (data.length < step) {
            hasMore = false;
          } else {
            from += step;
          }
        } else {
          hasMore = false;
        }
        success = true;
        break;
      } catch (err: any) {
        lastError = err;
        console.warn(`[Global Cache Retry] Range ${start} ~ ${end} (from: ${from}, attempt: ${attempt}) failed:`, err.message || err);
        await new Promise(r => setTimeout(r, attempt * 500));
      }
    }

    // 3회 재시도 모두 실패한 경우, 범위 분할(Sub-slicing)을 통한 부하 분산 가동
    if (!success) {
      if (start === end || depth >= 4) {
        console.error(`[Global Cache] Hard fail on range ${start} ~ ${end} at depth ${depth}. Error:`, lastError?.message || lastError);
        throw lastError || new Error(`Failed to load range ${start} ~ ${end}`);
      }

      const startDate = dayjs(start);
      const endDate = dayjs(end);
      const diffDays = endDate.diff(startDate, 'day');

      if (diffDays <= 0) {
        console.error(`[Global Cache] Impossible to split 1-day range ${start}. Error:`, lastError?.message || lastError);
        throw lastError || new Error(`Failed to load 1-day range ${start}`);
      }

      const midDays = Math.floor(diffDays / 2);
      const midDateStr = startDate.add(midDays, 'day').format('YYYY-MM-DD');
      const nextDateStr = startDate.add(midDays + 1, 'day').format('YYYY-MM-DD');

      console.log(`[Global Cache Self-Healing] Statement timeout or network fail. Splitting [${start} ~ ${end}] into [${start} ~ ${midDateStr}] and [${nextDateStr} ~ ${end}]`);

      // 쪼개진 두 하위 구간을 재귀 호출하여 데이터를 누적하고 루프를 빠져나옴
      const leftPart = await fetchRangeWithDynamicSlicing(start, midDateStr, step, depth + 1);
      const rightPart = await fetchRangeWithDynamicSlicing(nextDateStr, end, step, depth + 1);
      return [...leftPart, ...rightPart];
    }

    // API Rate limit 및 커넥션 풀 경감을 위한 10ms 초미세 딜레이
    await new Promise(r => setTimeout(r, 10));
  }

  return results;
}

// [전역 마스터 캐시 동기 빌드] 전체 로그 중 2개년 데이터만 초고속 압축하여 전역 메모리에 보존
async function buildGlobalYearlyAdSummaryCache() {
  if (isGlobalCacheLoading) return;
  isGlobalCacheLoading = true;
  try {
    console.log('[Global Cache] Starting unified high-speed monthly sliced memory cache compilation...');
    const supabase = getSupabase();
    
    let allData: any[] = [];
    const startYear = 2025;
    const endYear = 2026;
    
    const monthsList: { start: string; end: string }[] = [];
    for (let y = startYear; y <= endYear; y++) {
      for (let m = 1; m <= 12; m++) {
        const monthStr = m < 10 ? `0${m}` : `${m}`;
        let lastDay = 31;
        if (m === 4 || m === 6 || m === 9 || m === 11) {
          lastDay = 30;
        } else if (m === 2) {
          lastDay = (y % 4 === 0) ? 29 : 28;
        }
        
        // PostgreSQL 타임아웃을 방지하고 빠른 네트워크 처리를 위해 5일 단위로 초정밀 쪼개서 조회 (각 월당 6개의 슬라이스)
        monthsList.push({ start: `${y}-${monthStr}-01`, end: `${y}-${monthStr}-05` });
        monthsList.push({ start: `${y}-${monthStr}-06`, end: `${y}-${monthStr}-10` });
        monthsList.push({ start: `${y}-${monthStr}-11`, end: `${y}-${monthStr}-15` });
        monthsList.push({ start: `${y}-${monthStr}-16`, end: `${y}-${monthStr}-20` });
        monthsList.push({ start: `${y}-${monthStr}-21`, end: `${y}-${monthStr}-25` });
        monthsList.push({ start: `${y}-${monthStr}-26`, end: `${y}-${monthStr}-${lastDay}` });
      }
    }

    const step = 1000;

    for (const monthRange of monthsList) {
      try {
        const rangeData = await fetchRangeWithDynamicSlicing(monthRange.start, monthRange.end, step);
        allData = [...allData, ...rangeData];
      } catch (err: any) {
        console.error(`[Global Cache] DB load failed completely under range slice ${monthRange.start} ~ ${monthRange.end} after fallback:`, err.message || err);
        // 캐시 빌드의 안정성을 위해 일부 조각이 완전히 실패하더라도 루프를 계속 진행하여 최대한 많은 데이터를 적재
      }
    }

    const aggMap = new Map<string, any>();
    allData.forEach((r: any) => {
      const date = r.report_date || '';
      const market = (r.market || '').trim();
      const account = (r.account || '').trim();
      const adType = (r.ad_type || '').trim();
      const adGroup = (r.ad_group || '').trim();
      
      const key = `${date}_${market}_${account}_${adType}_${adGroup}`;
      
      if (!aggMap.has(key)) {
        aggMap.set(key, {
          report_date: date,
          market,
          account,
          ad_type: adType,
          ad_group: adGroup,
          cost: 0,
          conversions: 0,
          conversion_revenue: 0,
          impressions: 0,
          clicks: 0
        });
      }
      
      const entry = aggMap.get(key);
      entry.cost += Number(r.cost || 0);
      entry.conversions += Number(r.conversions || 0);
      entry.conversion_revenue += Number(r.conversion_revenue || 0);
      entry.impressions += Number(r.impressions || 0);
      entry.clicks += Number(r.clicks || 0);
    });

    globalYearlyAdSummaryCache = Array.from(aggMap.values());
    globalCacheLastUpdated = Date.now();

    const { data: latestRow, error: latestErr } = await supabase
      .from('ad_performance_logs')
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!latestErr && latestRow) {
      globalCacheLatestCreatedAt = latestRow.created_at || null;
    }

    console.log(`[Global Cache] Success. Total Aggregated: ${globalYearlyAdSummaryCache.length} rows (from ${allData.length} raw records). Latest created_at: ${globalCacheLatestCreatedAt}`);
  } catch (err: any) {
    console.error('[Global Cache] High-impact cache error:', err);
  } finally {
    isGlobalCacheLoading = false;
  }
}

// [전역 캐시 백그라운드 변동 식별] 정기적으로 변동 사항을 체크하여 갱신 트리거
async function verifyAndRefreshGlobalCacheIfNeeded() {
  if (isGlobalCacheLoading) return;
  if (Date.now() - globalCacheLastUpdated < 20000) return; // 감지 텀을 20초로 조정하여 불필요 체크 완화

  try {
    const supabase = getSupabase();
    const { data: latestRow, error } = await supabase
      .from('ad_performance_logs')
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn('[Global Cache Check] Swallowed background drift fetch check failure gracefully:', error.message);
      return;
    }

    const currentLatest = latestRow?.created_at || null;
    if (currentLatest !== globalCacheLatestCreatedAt) {
      console.log(`[Global Cache] Data drift detected (DB: ${currentLatest}, Cache: ${globalCacheLatestCreatedAt}). Active Rebuilding...`);
      buildGlobalYearlyAdSummaryCache();
    } else {
      globalCacheLastUpdated = Date.now();
    }
  } catch (err) {
    console.warn('[Global Cache Check] Swallowed unexpected error:', err);
  }
}

// 최초 구동 1.5초 후 초기 전역 캐시 자동 구축
setTimeout(() => {
  buildGlobalYearlyAdSummaryCache().catch(e => console.error('[Init] Failed to run initial global cache build:', e));
}, 1500);

async function buildAdCacheForUser(authHeader: string): Promise<UserCacheEntry | null> {
  const url = process.env.VITE_SUPABASE_URL || '';
  const key = process.env.VITE_SUPABASE_ANON_KEY || '';
  
  if (!url || !key) {
    console.error('[Yearly Cache] Missing Supabase Env URL/KEY in buildAdCacheForUser()');
    return null;
  }

  try {
    console.log(`[Yearly Cache] Starting query sequence for user auth token under RLS context with setSession...`);
    const supabase = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      }
    });

    const token = authHeader.replace('Bearer ', '').trim();
    const { error: sessionError } = await supabase.auth.setSession({
      access_token: token,
      refresh_token: token
    });

    if (sessionError) {
      console.warn('[Yearly Cache] Session application failed:', sessionError.message);
    }

    let allData: any[] = [];
    const startYear = 2025;
    const endYear = 2026;
    
    const monthsList: { start: string; end: string }[] = [];
    for (let y = startYear; y <= endYear; y++) {
      for (let m = 1; m <= 12; m++) {
        const monthStr = m < 10 ? `0${m}` : `${m}`;
        let lastDay = 31;
        if (m === 4 || m === 6 || m === 9 || m === 11) {
          lastDay = 30;
        } else if (m === 2) {
          lastDay = (y % 4 === 0) ? 29 : 28;
        }
        
        // PostgreSQL 타임아웃을 방지하고 빠른 네트워크 처리를 위해 5일 단위로 초정밀 쪼개서 조회 (각 월당 6개의 슬라이스)
        monthsList.push({ start: `${y}-${monthStr}-01`, end: `${y}-${monthStr}-05` });
        monthsList.push({ start: `${y}-${monthStr}-06`, end: `${y}-${monthStr}-10` });
        monthsList.push({ start: `${y}-${monthStr}-11`, end: `${y}-${monthStr}-15` });
        monthsList.push({ start: `${y}-${monthStr}-16`, end: `${y}-${monthStr}-20` });
        monthsList.push({ start: `${y}-${monthStr}-21`, end: `${y}-${monthStr}-25` });
        monthsList.push({ start: `${y}-${monthStr}-26`, end: `${y}-${monthStr}-${lastDay}` });
      }
    }

    const step = 1000;

    for (const monthRange of monthsList) {
      let from = 0;
      let hasMore = true;
      
      while (hasMore) {
        const { data, error } = await supabase
          .from('ad_performance_logs')
          .select('id, market, ad_type, account, report_date, impressions, clicks, cost, conversions, conversion_revenue, ad_group')
          .gte('report_date', monthRange.start)
          .lte('report_date', monthRange.end)
          .range(from, from + step - 1);

        if (error) {
          console.error(`[Yearly Cache] Database fetch error under User auth for slice ${monthRange.start} ~ ${monthRange.end}:`, error.message);
          break;
        }

        if (data && data.length > 0) {
          allData = [...allData, ...data];
          if (data.length < step) {
            hasMore = false;
          } else {
            from += step;
            await new Promise(r => setTimeout(r, 20));
          }
        } else {
          hasMore = false;
        }
      }
    }

    const aggMap = new Map<string, any>();
    allData.forEach((r: any) => {
      const date = r.report_date || '';
      const market = (r.market || '').trim();
      const account = (r.account || '').trim();
      const adType = (r.ad_type || '').trim();
      const adGroup = (r.ad_group || '').trim();
      
      const key = `${date}_${market}_${account}_${adType}_${adGroup}`;
      
      if (!aggMap.has(key)) {
        aggMap.set(key, {
          report_date: date,
          market,
          account,
          ad_type: adType,
          ad_group: adGroup,
          cost: 0,
          conversions: 0,
          conversion_revenue: 0,
          impressions: 0,
          clicks: 0
        });
      }
      
      const entry = aggMap.get(key);
      entry.cost += Number(r.cost || 0);
      entry.conversions += Number(r.conversions || 0);
      entry.conversion_revenue += Number(r.conversion_revenue || 0);
      entry.impressions += Number(r.impressions || 0);
      entry.clicks += Number(r.clicks || 0);
    });

    const aggregated = Array.from(aggMap.values());

    const { data: latestRow, error: latestErr } = await supabase
      .from('ad_performance_logs')
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const latestCreatedAt = (!latestErr && latestRow) ? (latestRow.created_at || null) : null;

    console.log(`[Yearly Cache] Successfully compressed ad logs for user. Count: ${aggregated.length} (parsed ${allData.length} raw rows). Latest created_at: ${latestCreatedAt}`);

    return {
      aggregatedData: aggregated,
      latestCreatedAt,
      lastUpdated: Date.now(),
      isLoading: false
    };
  } catch (err: any) {
    console.error('[Yearly Cache] Failed to build user cache safely:', err);
    return null;
  }
}

async function verifyAndRefreshUserCache(authHeader: string, currentEntry: UserCacheEntry) {
  if (currentEntry.isLoading) return;
  if (Date.now() - currentEntry.lastUpdated < 30000) return; // 체크 주기 완화 (30초)

  try {
    const url = process.env.VITE_SUPABASE_URL || '';
    const key = process.env.VITE_SUPABASE_ANON_KEY || '';
    const supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const token = authHeader.replace('Bearer ', '').trim();
    await supabase.auth.setSession({
      access_token: token,
      refresh_token: token
    });

    const { data: latestRow, error } = await supabase
      .from('ad_performance_logs')
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn('[Yearly Cache Check] Background drift limit query bypassed safely:', error.message);
      return;
    }

    const dbLatest = latestRow?.created_at || null;
    if (dbLatest !== currentEntry.latestCreatedAt) {
      console.log('[Yearly Cache] Data drift detected for user token. Refreshing cache in background...');
      currentEntry.isLoading = true;
      buildAdCacheForUser(authHeader)
        .then(newEntry => {
          if (newEntry) {
            authUserCacheMap.set(authHeader, newEntry);
            console.log('[Yearly Cache] Background User cache update success.');
          }
        })
        .catch(err => {
          console.error('[Yearly Cache] Background User cache update failed:', err);
        })
        .finally(() => {
          currentEntry.isLoading = false;
        });
    } else {
      currentEntry.lastUpdated = Date.now();
    }
  } catch (err: any) {
    console.warn('[Yearly Cache Check] Unexpected background check bypassed safely:', err);
  }
}

// API Route for Aggregated Yearly Ad Performance Summary (Performance optimization for Tree Table with User RLS Context)
api.get('/ad/yearly-summary', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    
    // 만약 authHeader가 없으면 비로그인(anon) 상태이므로 즉각 최속 마스터 전역 캐시를 리턴
    if (!authHeader) {
      if (globalYearlyAdSummaryCache.length === 0) {
        console.log('[Yearly Summary API] Global Cache is empty for anon access. Triggering background build...');
        buildGlobalYearlyAdSummaryCache(); // 동기식 대기 전면 철폐 (비동기로만 트리거)
      } else {
        verifyAndRefreshGlobalCacheIfNeeded();
      }
      return res.json({ success: true, data: globalYearlyAdSummaryCache });
    }

    let cacheEntry = authUserCacheMap.get(authHeader);

    // [전격대혁명] 유저의 캐시가 메모리에 아예 없는 최초 접근 시에도 절대로 await 하지 않고 즉각 반응 응답을 전송!
    if (!cacheEntry) {
      console.log('[Yearly Summary API] Cache miss. Initiating background secure cache compiling for the user to prevent HTTP 504 timeouts...');
      
      // 즉시 로딩중 상태의 가벼운 플레이스홀더를 등록하고, 클라이언트 대기 프리징 해제
      const initLock: UserCacheEntry = {
        aggregatedData: [],
        latestCreatedAt: null,
        lastUpdated: Date.now(),
        isLoading: true
      };
      authUserCacheMap.set(authHeader, initLock);

      // 백그라운드 프라미스를 통해 비동기로 안전한 무결 캐싱 구축 기동
      buildAdCacheForUser(authHeader)
        .then(newEntry => {
          if (newEntry) {
            authUserCacheMap.set(authHeader, newEntry);
            console.log('[Yearly Summary API] Async initial user cache compile completed successfully.');
          } else {
            authUserCacheMap.delete(authHeader);
          }
        })
        .catch(err => {
          authUserCacheMap.delete(authHeader);
          console.error('[Yearly Summary API] Async initial user cache compile threw error:', err);
        });

      cacheEntry = initLock;
    } else {
      // 캐시가 존재할 때는 유저에겐 즉시 1ms만에 응답을 넘겨주고, 백그라운드에서 조용히 DB와 실시간 동기조율 분석 이행
      verifyAndRefreshUserCache(authHeader, cacheEntry);
    }

    // ★ 하이브리드 대방어 Fallback:
    // 유저의 캐시 데이터가 비어있고 로딩중인 시기에는, 사용자에게 데이터 없음 상태를 노출하기보다
    // 검증된 전역 마스터 캐시를 융합해서 즉각 리턴함으로써 화면 무결성을 극도로 지킨다!
    const responseData = (cacheEntry && cacheEntry.aggregatedData && cacheEntry.aggregatedData.length > 0)
      ? cacheEntry.aggregatedData
      : globalYearlyAdSummaryCache;

    if (responseData.length === 0) {
      console.log('[Yearly Summary API] Fallback triggers. Triggering global cache async build...');
      buildGlobalYearlyAdSummaryCache();
    }

    res.json({ success: true, data: responseData.length > 0 ? responseData : globalYearlyAdSummaryCache });
  } catch (err: any) {
    console.error('[Yearly Summary API Error]:', err);
    res.json({ success: true, data: globalYearlyAdSummaryCache });
  }
});

// API Route for Naver Category
api.get('/naver/category', async (req, res) => {
  const query = req.query.query as string;
  if (!query) {
    return res.status(400).json({ error: 'Query parameter is required' });
  }

  try {
    const url = `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(query)}`;
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    const response = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://search.shopping.naver.com/'
      }
    });
    
    if (!response.ok) throw new Error(`Naver Shopping returned ${response.status}`);

    const html = await response.text();
    const $ = cheerio.load(html);

    const preloadedStateScript = $('script:contains("window.__PRELOADED_STATE__")').html();
    if (preloadedStateScript) {
      try {
        const jsonString = preloadedStateScript.replace(/window\.__PRELOADED_STATE__\s*=\s*/, '').trim();
        const preloadedState = JSON.parse(jsonString);
        const products = preloadedState.product?.list || preloadedState.search?.shoppingResult?.products;
        
        if (products && products.length > 0) {
          const firstProduct = products[0];
          const categories = [
            firstProduct.category1Name,
            firstProduct.category2Name,
            firstProduct.category3Name,
            firstProduct.category4Name
          ].filter(Boolean).join(' > ');
          
          if (categories) return res.json({ category: categories });
        }
      } catch (e) {
        console.error('Failed to parse __PRELOADED_STATE__:', e);
      }
    }

    const categoryRegex = /["']category[1-4]Name["']\s*:\s*["']([^"']+)["']/g;
    const matches = [...html.matchAll(categoryRegex)];
    
    if (matches.length > 0) {
      const categoryMap = new Map<string, string>();
      matches.forEach(m => {
        if (m[0].includes('category1Name') && !categoryMap.has('1')) categoryMap.set('1', m[1]);
        if (m[0].includes('category2Name') && !categoryMap.has('2')) categoryMap.set('2', m[1]);
        if (m[0].includes('category3Name') && !categoryMap.has('3')) categoryMap.set('3', m[1]);
        if (m[0].includes('category4Name') && !categoryMap.has('4')) categoryMap.set('4', m[1]);
      });

      const categories = [
        categoryMap.get('1'),
        categoryMap.get('2'),
        categoryMap.get('3'),
        categoryMap.get('4')
      ].filter(Boolean).join(' > ');

      if (categories) return res.json({ category: categories });
    }

    const nextDataScript = $('#__NEXT_DATA__').html();
    if (nextDataScript) {
      try {
        const nextData = JSON.parse(nextDataScript);
        const products = nextData.props?.pageProps?.initialState?.products?.list;
        
        if (products && products.length > 0) {
          const firstProduct = products[0];
          const categories = [
            firstProduct.category1Name,
            firstProduct.category2Name,
            firstProduct.category3Name,
            firstProduct.category4Name
          ].filter(Boolean).join(' > ');
          
          if (categories) return res.json({ category: categories });
        }
      } catch (e) {
        console.error('Failed to parse __NEXT_DATA__:', e);
      }
    }

    const categoryElements = $('[class^="product_category"], [class*="_category_"]');
    if (categoryElements.length > 0) {
       const categories: string[] = [];
       categoryElements.first().find('a, span').each((_, el) => {
          const text = $(el).text().trim();
          if (text && !categories.includes(text)) categories.push(text);
       });
       if (categories.length > 0) return res.json({ category: categories.slice(0, 4).join(' > ') });
    }

    const depthElement = $('[class*="basicList_depth"]');
    if (depthElement.length > 0) {
      const categories: string[] = [];
      depthElement.first().find('span').each((_, el) => {
        const text = $(el).text().trim();
        if (text) categories.push(text);
      });
      if (categories.length > 0) return res.json({ category: categories.join(' > ') });
    }

    return res.status(404).json({ error: 'Category not found' });

  } catch (error: any) {
    console.error('Error fetching Naver category:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch category',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// API Route for search_csv_keywords NLP Preprocess & Upsert
api.post('/search-csv-keywords/upsert', async (req, res) => {
  try {
    const { 
      extractedKeyword, 
      fileKeyword1, 
      fileKeyword2, 
      fileKeyword3, 
      detailsArray, 
      cleanedRowBase,
      relatedKeywords
    } = req.body;

    if (!extractedKeyword) {
      return res.status(400).json({ error: 'extractedKeyword is required' });
    }

    const supabase = getSupabase();

    // =========================================================================
    // ① [기존 키워드 조회 - ID 및 카테고리 정보 정밀 다중 행 방어 조회]
    // =========================================================================
    let existingRow: any = null;
    try {
      const { data: dbRows, error: fetchError } = await supabase
        .from('search_csv_keywords')
        .select('id, keyword, category_base, representative_category')
        .eq('keyword', extractedKeyword.trim());
      
      if (!fetchError && dbRows && dbRows.length > 0) {
        existingRow = dbRows[0];
      }
    } catch (fetchErr) {
      console.error('[Backend Fetch Existing Row Error] Gracefully bypassed:', fetchErr);
    }

    // [전달받은 상품 데이터 배열 안전 가드]
    const safeDetailsArray = Array.isArray(detailsArray) ? detailsArray : [];

    // [단어 덩어리(Term) 단위 칸수 측정 공식 및 중복 제거 알고리즘]
    const calculateDistance = (prodName: string, keyword: string, keywordX: string, keywordY: string): number | null => {
      if (!prodName || !keyword || !keywordX || !keywordY) return null;
      try {
        // 1단계: 마스터 keyword 최우선 매칭 및 토큰 격리
        const escapedChars = Array.from(keyword).map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const keywordRegexPattern = escapedChars.join('\\s*');
        const keywordRegex = new RegExp(keywordRegexPattern, 'gi');

        let processedProdName = prodName;
        const match = prodName.match(keywordRegex);
        let matchedKeywordStr = keyword;
        if (match) {
          matchedKeywordStr = match[0]; // 매칭된 실제 텍스트
          processedProdName = prodName.replace(keywordRegex, '__MASTER_KEYWORD__');
        }

        // 2단계: 공백 단위 분할 및 연속/인접 중복 제거
        const words = processedProdName.split(/\s+/).filter(Boolean);
        const uniqueWords: string[] = [];
        words.forEach(w => {
          if (uniqueWords.length === 0 || uniqueWords[uniqueWords.length - 1] !== w) {
            uniqueWords.push(w);
          }
        });

        // 치환했던 특수 토큰 __MASTER_KEYWORD__ 를 원래의 매칭된 문자열로 복원
        const finalWords = uniqueWords.map(w => w === '__MASTER_KEYWORD__' ? matchedKeywordStr : w);

        // 3단계: keywordX와 keywordY가 포함된 인덱스 찾기
        const idxX = finalWords.findIndex(w => w.includes(keywordX));
        const idxY = finalWords.findIndex(w => w.includes(keywordY));

        if (idxX === -1 || idxY === -1) {
          return null; // 찾지 못한 경우 제외
        }

        if (idxX < idxY) {
          return idxY - idxX;
        } else if (idxX > idxY) {
          return (idxX - idxY) + 1; // 역배열 페널티 1칸
        } else {
          return 0; // 한 단어 안에 둘 다 있는 경우 0칸
        }
      } catch (err) {
        console.error('[calculateDistance error] Safe handled:', err);
        return null;
      }
    };

    // [지시 1 & 2] 10점 키워드에 대한 position_score '1칸' 강제 연산 가드 구축을 위해 고정 가점 배열을 선제 파싱
    const rawArrayFixed = cleanedRowBase?.array_fixed_score;
    const arrayFixedScoreArrForGuard: string[] = [];
    if (rawArrayFixed) {
      if (Array.isArray(rawArrayFixed)) {
        rawArrayFixed.forEach((v: any) => arrayFixedScoreArrForGuard.push(String(v).trim()));
      } else {
        const strVal = String(rawArrayFixed).trim();
        let parsedArr: string[] = [];
        if (strVal.startsWith('[') && strVal.endsWith(']')) {
          try {
            const parsed = JSON.parse(strVal);
            if (Array.isArray(parsed)) {
              parsedArr = parsed.map((v: any) => String(v).trim());
            }
          } catch (e) {
            // ignore
          }
        }
        if (parsedArr.length === 0) {
          parsedArr = strVal.split(/[\n,;]+/).map((s: any) => s.trim());
        }
        parsedArr.filter(Boolean).forEach(v => arrayFixedScoreArrForGuard.push(v));
      }
    }

    const getFixedScoreForCombo = (combo: string): number | null => {
      if (arrayFixedScoreArrForGuard.length === 0) return null;
      for (const item of arrayFixedScoreArrForGuard) {
        const parts = item.split(':');
        if (parts.length === 2 && parts[0].trim() === combo.trim()) {
          const score = parseInt(parts[1].trim(), 10);
          if (!isNaN(score)) return score;
        }
      }
      return null;
    };

    const finalPositionScores: string[] = [];
    if (fileKeyword1 && fileKeyword2) {
      if (!fileKeyword3) {
        // [조건 1] 키워드가 keyword_1, keyword_2만 존재할 때 (group1 대상)
        const group1 = safeDetailsArray.filter((row: any) => {
          const prodName = row.product_name || "";
          return prodName.includes(fileKeyword1) && prodName.includes(fileKeyword2);
        }).slice(0, 10);

        const distances: number[] = [];
        group1.forEach((row: any) => {
          const prodName = row.product_name || "";
          const dist = calculateDistance(prodName, extractedKeyword, fileKeyword1, fileKeyword2);
          if (dist !== null) {
            distances.push(dist);
          }
        });

        const maxDist = distances.length > 0 ? Math.max(...distances) : 0;
        const comboName = `${fileKeyword1}${fileKeyword2}`;
        const fixedScore = getFixedScoreForCombo(comboName);
        // [지시 1] array_fixed_score가 정확히 10인 경우 position_score는 무조건 '1칸'으로 강제 우회 적용
        const finalDistStr = (fixedScore === 10) ? '1칸' : `${maxDist}칸`;
        finalPositionScores.push(`${comboName}:${finalDistStr}`);
      } else {
        // [조건 2] 키워드가 keyword_1, keyword_2, keyword_3 모두 존재할 때 (group2 대상)
        const group2 = safeDetailsArray.filter((row: any) => {
          const prodName = row.product_name || "";
          return prodName.includes(fileKeyword1) && prodName.includes(fileKeyword2) && prodName.includes(fileKeyword3);
        }).slice(0, 10);

        // 세트 A (keyword_1과 keyword_2 간)
        const distancesA: number[] = [];
        group2.forEach((row: any) => {
          const prodName = row.product_name || "";
          const dist = calculateDistance(prodName, extractedKeyword, fileKeyword1, fileKeyword2);
          if (dist !== null) {
            distancesA.push(dist);
          }
        });
        const maxDistA = distancesA.length > 0 ? Math.max(...distancesA) : 0;
        const comboNameA = `${fileKeyword1}${fileKeyword2}`;
        const fixedScoreA = getFixedScoreForCombo(comboNameA);
        // [지시 1] array_fixed_score가 정확히 10인 경우 position_score는 무조건 '1칸'으로 강제 우회 적용
        const finalDistStrA = (fixedScoreA === 10) ? '1칸' : `${maxDistA}칸`;
        finalPositionScores.push(`${comboNameA}:${finalDistStrA}`);

        // 세트 B (keyword_2과 keyword_3 간)
        const distancesB: number[] = [];
        group2.forEach((row: any) => {
          const prodName = row.product_name || "";
          const dist = calculateDistance(prodName, extractedKeyword, fileKeyword2, fileKeyword3);
          if (dist !== null) {
            distancesB.push(dist);
          }
        });
        const maxDistB = distancesB.length > 0 ? Math.max(...distancesB) : 0;
        const comboNameB = `${fileKeyword2}${fileKeyword3}`;
        const fixedScoreB = getFixedScoreForCombo(comboNameB);
        // [지시 1] array_fixed_score가 정확히 10인 경우 position_score는 무조건 '1칸'으로 강제 우회 적용
        const finalDistStrB = (fixedScoreB === 10) ? '1칸' : `${maxDistB}칸`;
        finalPositionScores.push(`${comboNameB}:${finalDistStrB}`);
      }
    }

    // =========================================================================
    // ② [category_base 결정 룰 및 NOT NULL 방어]
    // =========================================================================
    let finalCategoryBase = 'X';
    if (!existingRow) {
      const payloadCategoryBase = cleanedRowBase?.category_base;
      const validBases = ['단일', '혼합', 'X'];
      if (payloadCategoryBase && validBases.includes(payloadCategoryBase)) {
        finalCategoryBase = payloadCategoryBase;
      } else {
        // NLP 룰 적용: 형태소들의 유무에 따른 동적 자동 분류
        if (fileKeyword1) {
          if (fileKeyword2 || fileKeyword3) {
            finalCategoryBase = '혼합';
          } else {
            finalCategoryBase = '단일';
          }
        } else {
          finalCategoryBase = 'X';
        }
      }
    } else {
      finalCategoryBase = existingRow.category_base || 'X';
    }

    // =========================================================================
    // ③ [모든 컬럼 데이터 타입 및 형식 가드 - Bulletproof Sanitizer]
    // =========================================================================
    
    // 수치 가드 함수 (숫자만 추출하여 정수로 파싱)
    const parseIntegerSafe = (val: any): number | null => {
      if (val === null || val === undefined || val === '') return null;
      if (typeof val === 'number') return isNaN(val) ? null : Math.floor(val);
      const cleaned = String(val).replace(/[^0-9-]/g, '');
      const parsed = parseInt(cleaned, 10);
      return isNaN(parsed) ? null : parsed;
    };

    // 실수 가드 함수 (실수만 추출하여 소수로 파싱)
    const parseFloatSafe = (val: any): number | null => {
      if (val === null || val === undefined || val === '') return null;
      if (typeof val === 'number') return isNaN(val) ? null : val;
      const cleaned = String(val).replace(/[^0-9.-]/g, '');
      const parsed = parseFloat(cleaned);
      return isNaN(parsed) ? null : parsed;
    };

    // 문자열 배열 가드 함수 (text[] 타입 변환 및 JSON 문자열 대괄호 격리 복원 완벽 대응)
    const parseArraySafe = (val: any): string[] => {
      if (!val) return [];
      if (Array.isArray(val)) {
        return val.map(v => String(v).trim()).filter(Boolean);
      }
      const strVal = String(val).trim();
      if (strVal.startsWith('[') && strVal.endsWith(']')) {
        try {
          const parsed = JSON.parse(strVal);
          if (Array.isArray(parsed)) {
            return parsed.map(v => String(v).trim()).filter(Boolean);
          }
        } catch (e) {
          // JSON 파싱 실패 시 일반 split으로 자동 Fallback
        }
      }
      return strVal
        .split(/[\n,;]+/)
        .map(s => s.trim())
        .filter(Boolean);
    };

    const rawKeywordVal = cleanedRowBase?.keyword_value_order;
    const keywordValueOrderArr = parseArraySafe(rawKeywordVal);

    const categoryTermsArr = parseArraySafe(cleanedRowBase?.category_terms);
    const arrayFixedScoreArr = parseArraySafe(cleanedRowBase?.array_fixed_score);
    const productNameScoreArr = parseArraySafe(cleanedRowBase?.product_name_score);
    const positionScoreArr = finalPositionScores.length > 0 ? finalPositionScores : parseArraySafe(cleanedRowBase?.position_score);

    // =========================================================================
    // [동일 대표 카테고리 기반 category_terms 정밀 복구 로직]
    // =========================================================================
    let finalCategoryTerms = [...categoryTermsArr];
    let repCategoryVal = cleanedRowBase?.representative_category || null;
    if (repCategoryVal && ['단일', '혼합', 'X'].includes(String(repCategoryVal).trim())) {
      repCategoryVal = null;
    }
    if (repCategoryVal && finalCategoryTerms.length === 0) {
      try {
        const { data: catRows, error: catError } = await supabase
          .from('search_csv_keywords')
          .select('category_terms')
          .eq('representative_category', String(repCategoryVal).trim())
          .not('category_terms', 'is', null);
        
        if (!catError && catRows && catRows.length > 0) {
          for (const row of catRows) {
            const arr = parseArraySafe(row.category_terms);
            if (arr.length > 0) {
              finalCategoryTerms = arr;
              break;
            }
          }
        }
      } catch (catFetchErr) {
        console.error('[Backend Category Terms Fetch Error] Gracefully bypassed:', catFetchErr);
      }
    }

    const safeTotalSearchCount = parseIntegerSafe(cleanedRowBase?.total_search_count);
    const safeProductCount = parseIntegerSafe(cleanedRowBase?.product_count);
    const safeCompetitionRate = parseFloatSafe(cleanedRowBase?.competition_rate);

    let safeProductDetailsArray: any[] = [];
    if (Array.isArray(detailsArray) && detailsArray.length > 0) {
      safeProductDetailsArray = detailsArray;
    } else if (Array.isArray(cleanedRowBase?.product_details_array)) {
      safeProductDetailsArray = cleanedRowBase.product_details_array;
    } else if (typeof cleanedRowBase?.product_details_array === 'string' && cleanedRowBase.product_details_array) {
      try {
        safeProductDetailsArray = JSON.parse(cleanedRowBase.product_details_array);
      } catch (jsonErr) {
        safeProductDetailsArray = [];
      }
    }

    // =========================================================================
    // =========================================================================
    // ④ [area_value_order - product_name_score 4단계 독립 역추적 매칭 알고리즘]
    // =========================================================================
    const findAreaValueOrder = (
      nameScores: string[],
      products: any[],
      terms: string[],
      repCategory?: string | null,
      kw1?: string | null,
      kw2?: string | null,
      kw3?: string | null
    ): string[] => {
      // 1. 점수가 40점 미만인 타겟 단어 추출 (40은 제외 및 40 초과 배제)
      const targetTerms: string[] = [];
      if (Array.isArray(nameScores) && nameScores.length > 0) {
        nameScores.forEach(scoreStr => {
          const parts = scoreStr.split(':');
          if (parts.length === 2) {
            const term = parts[0].trim();
            const score = parseInt(parts[1].trim(), 10);
            if (!isNaN(score) && score < 40 && term) {
              targetTerms.push(term);
            }
          }
        });
      }

      // 만약 배열 내 모든 단어가 40점일 경우 연산을 건너뛰십시오. (빈 배열 반환)
      if (targetTerms.length === 0) {
        return [];
      }

      // 2. 랭킹 순으로 정렬된 상품 목록 준비
      const sortedProducts = products && products.length > 0 
        ? [...products].sort((a, b) => {
            const rankA = parseInt(a.ranking, 10) || 999;
            const rankB = parseInt(b.ranking, 10) || 999;
            return rankA - rankB;
          })
        : [];

      const finalResults: string[] = [];

      for (const term of targetTerms) {
        let matchedResult: string | null = null;

        // [1단계 (그룹화)]
        // 상위 노출 상품 리스트 전체를 조회하여, 해당 타겟 단어가 상품명에 포함되지 않은 상품들만 따로 필터링하여 하나의 그룹 데이터셋으로 1차 묶음
        let groupProducts = sortedProducts.filter(product => {
          const prodName = product.product_name || product.prodName || '';
          return !prodName.includes(term);
        });

        // 만약 그룹화된 상품이 하나도 없다면, 매칭을 위해 전체 상품 목록을 fallback 그룹셋으로 사용
        if (groupProducts.length === 0) {
          groupProducts = sortedProducts;
        }

        // [2단계 (상위 계층 순회)]
        // 그룹화된 상품들을 처음부터 끝까지 순회하며 1순위 [속성] 또는 2순위 [태그]에 타겟 키워드가 포함되어 있는지 검사
        for (const product of groupProducts) {
          // 1순위 [속성]: specs_attributes
          const specs = product.specs_attributes || '';
          if (specs !== '-' && specs.includes(term)) {
            const foundWord = specs.split('|').map(s => s.trim()).find(s => s.includes(term)) || term;
            matchedResult = `[속성] ${term}#${foundWord} (${product.mall_name || ''})(${product.product_name || product.prodName || ''})`;
            break;
          }

          // 2순위 [태그]: search_tag
          const tags = product.search_tag || '';
          if (tags !== '-' && tags.includes(term)) {
            const foundWord = tags.split(/[\s,;]+/).find(s => s.includes(term)) || term;
            matchedResult = `[태그] ${term}#${foundWord} (${product.mall_name || ''})(${product.product_name || product.prodName || ''})`;
            break;
          }
        }

        // [3단계 (하위 계층 매칭)]
        // 2단계 전체 순회에서 매칭된 상품이 단 하나도 없을 경우에만, 다시 그룹화된 상품의 처음으로 돌아와 3순위 [카테고리] 또는 4순위 [쇼핑몰명] 체크
        if (!matchedResult) {
          for (const product of groupProducts) {
            // 3순위 [카테고리]: representative_category 1:1 대조 및 category_terms 포함 체크
            const repCatStr = repCategory ? repCategory.trim() : '';
            const isActiveCategoryMatch = repCatStr !== '' && !['단일', '혼합', 'X'].includes(repCatStr);
            const safeCategoryTerms = (terms || []).map(t => String(t).trim());
            const categoryMatchWord = safeCategoryTerms.find(t => t.includes(term));
            if (isActiveCategoryMatch && categoryMatchWord) {
              matchedResult = `[카테고리] ${term}#${categoryMatchWord} (${product.mall_name || ''})(${product.product_name || product.prodName || ''})`;
              break;
            }

            // 4순위 [쇼핑몰명]: mall_name
            const mall = product.mall_name || '';
            if (mall !== '' && mall.includes(term)) {
              matchedResult = `[쇼핑몰명] ${term}#${mall} (${product.mall_name || ''})(${product.product_name || product.prodName || ''})`;
              break;
            }
          }
        }

        // 1~4순위 매칭 모두 실패 시의 Fallback ([동의어] 분류 및 예외 포맷 적용)
        if (!matchedResult) {
          const fallbackProduct = groupProducts[0] || sortedProducts[0];
          if (fallbackProduct) {
            const mall = fallbackProduct.mall_name || '';
            const prodName = fallbackProduct.product_name || fallbackProduct.prodName || '';
            matchedResult = `[동의어] ${term}# (${mall})(${prodName})`;
          } else {
            matchedResult = `[동의어] ${term}# ()()`;
          }
        }

        if (matchedResult) {
          finalResults.push(matchedResult);
        }
      }

      return finalResults;
    };

    // 우선순위 역추적 알고리즘으로 area_value_order 매칭 (문자열 배열 반환)
    let areaValueOrderResult: string[] = findAreaValueOrder(
      productNameScoreArr,
      safeProductDetailsArray,
      finalCategoryTerms,
      cleanedRowBase?.representative_category || null,
      fileKeyword1,
      fileKeyword2,
      fileKeyword3
    );

    // 알고리즘 매칭 실패 시, 클라이언트에서 보낸 기존 area_value_order 값을 배열로 보존 시도
    if ((!areaValueOrderResult || areaValueOrderResult.length === 0) && cleanedRowBase?.area_value_order != null) {
      areaValueOrderResult = parseArraySafe(cleanedRowBase.area_value_order);
    }

    const baseDataToSave: any = {
      keyword: extractedKeyword.trim(), // 띄어쓰기 없는 고유 매칭 키 강제 고정
      keyword_1: cleanedRowBase?.keyword_1 || fileKeyword1 || null,
      keyword_2: cleanedRowBase?.keyword_2 || fileKeyword2 || null,
      keyword_3: cleanedRowBase?.keyword_3 || fileKeyword3 || null,
      array_fixed_score: arrayFixedScoreArr,
      position_score: positionScoreArr,
      product_name_score: productNameScoreArr,
      area_value_order: areaValueOrderResult,
      representative_category: cleanedRowBase?.representative_category || null,
      total_search_count: safeTotalSearchCount,
      product_count: safeProductCount,
      competition_rate: safeCompetitionRate,
      keyword_value_order: keywordValueOrderArr,
      category_terms: finalCategoryTerms,
      product_details_array: safeProductDetailsArray,
      updated_at: new Date().toISOString()
    };

    let saveSuccess = false;
    let saveError: any = null;

    if (existingRow) {
      // -----------------------------------------------------------------------
      // [분기 레일 2: DB에 이미 키워드가 존재하는 경우 ➔ 최신화 (UPDATE)]
      // -----------------------------------------------------------------------
      const updatePayload = { ...baseDataToSave };
      
      // 기존 안착된 category_base 및 representative_category 데이터는 페이로드에서 명시적으로 제외(Omit)하여 원형 그대로 상속 수호합니다.
      delete updatePayload.category_base;
      delete updatePayload.representative_category;
      delete updatePayload.keyword; // WHERE 조건절에서 사용하므로 페이로드 제외

      const { error: updateError } = await supabase
        .from('search_csv_keywords')
        .update(updatePayload)
        .eq('id', existingRow.id); // [지시 2] 기존 행의 식별자(id)를 추적하여 관련 설정값들만 매칭하여 UPDATE(개신 저장)

      if (!updateError) {
        saveSuccess = true;
      } else {
        console.error("[Backend Update] DB update failed. error details:", updateError);
        saveError = updateError;
      }
    }

    // 기존에 없었거나, 업데이트가 실패한 경우 생성(INSERT) 시도
    if (!saveSuccess) {
      // -----------------------------------------------------------------------
      // [분기 레일 1: DB에 키워드가 없는 경우 ➔ 신규 생성 (INSERT)]
      // -----------------------------------------------------------------------
      const insertPayload: any = {
        ...baseDataToSave,
        category_base: finalCategoryBase
      };

      // [지시 1] '연관 키워드 분석' 데이터 대조 매핑 적재
      if (Array.isArray(relatedKeywords) && relatedKeywords.length > 0) {
        const matchedRel = relatedKeywords.find(k => k && String(k.keyword).trim() === extractedKeyword.trim());
        if (matchedRel) {
          const relSearch = matchedRel.totalSearchCount !== undefined ? matchedRel.totalSearchCount : (matchedRel.total_search_count !== undefined ? matchedRel.total_search_count : matchedRel.totalSearch);
          const relProduct = matchedRel.product_count !== undefined ? matchedRel.product_count : matchedRel.productCount;
          const relCompetition = matchedRel.competition_intensity !== undefined ? matchedRel.competition_intensity : (matchedRel.competitionIntensity !== undefined ? matchedRel.competitionIntensity : matchedRel.competition_rate);

          if (relSearch !== undefined && relSearch !== null && relSearch !== '') {
            insertPayload.total_search_count = parseIntegerSafe(relSearch);
          }
          if (relProduct !== undefined && relProduct !== null && relProduct !== '') {
            insertPayload.product_count = parseIntegerSafe(relProduct);
          }
          if (relCompetition !== undefined && relCompetition !== null && relCompetition !== '') {
            insertPayload.competition_rate = parseFloatSafe(relCompetition);
          }
        }
      }

      const { error: insertError } = await supabase
        .from('search_csv_keywords')
        .insert([insertPayload]);

      if (!insertError) {
        saveSuccess = true;
      } else {
        // [초강력 예외 가드: 고유 키 중복(23505)으로 insert 실패 시 즉시 update로 안전 회항]
        if (insertError.code === '23505') {
          console.warn("[Backend Insert] Unique violation (23505). Falling back to keyword-based update...");
          const updatePayload = { ...baseDataToSave };
          
          delete updatePayload.keyword;

          const { error: retryUpdateError } = await supabase
            .from('search_csv_keywords')
            .update(updatePayload)
            .eq('keyword', extractedKeyword.trim());

          if (!retryUpdateError) {
            saveSuccess = true;
          } else {
            saveError = retryUpdateError;
          }
        } else {
          saveError = insertError;
        }
      }
    }

    if (!saveSuccess) {
      console.error("[Backend Save All Failed] Final persistent error details:", saveError);
      return res.status(500).json({ 
        error: saveError?.message || 'Save failed', 
        details: saveError?.details,
        code: saveError?.code,
        hint: saveError?.hint
      });
    }

    return res.json({ success: true, position_score: finalPositionScores, category_base: finalCategoryBase });

  } catch (error: any) {
    console.error('[Backend Upsert] Exception caught:', error);
    return res.status(500).json({ error: error.message });
  }
});

// API Route for related-keywords XLSX representative_category Sync (Atomic Dual-Table Synchronization Engine)
api.post('/related-keywords/upload-category-sync', async (req, res) => {
  try {
    const { keywords, category: fallbackCategory, targetCode, relatedKeywords } = req.body;
    console.log('[XLSX Category Sync] START =======================================');
    console.log('[XLSX Category Sync] Received TargetCode:', targetCode);
    console.log('[XLSX Category Sync] Fallback Category:', fallbackCategory);
    console.log('[XLSX Category Sync] Raw Keywords Count:', keywords ? keywords.length : 0);

    if (!keywords || !Array.isArray(keywords)) {
      return res.status(400).json({ error: 'keywords array is required' });
    }

    const supabase = getSupabase();

    // =========================================================================
    // ① [1단계: 파일 전체 기준 최빈 대표 카테고리(Dominant Category) 산출]
    // =========================================================================
    const categoryCounts = new Map<string, number>();
    
    keywords.forEach((item: any) => {
      const rawCategory = (item.representative_category || '').trim();
      if (rawCategory) {
        categoryCounts.set(rawCategory, (categoryCounts.get(rawCategory) || 0) + 1);
      }
    });

    let dominantCategory = '';
    let maxCount = 0;
    for (const [cat, count] of categoryCounts.entries()) {
      if (count > maxCount) {
        maxCount = count;
        dominantCategory = cat;
      }
    }

    // 파일 내 대표 카테고리가 전혀 존재하지 않는 극한 조건의 경우에만 fallbackCategory 적용
    if (!dominantCategory && fallbackCategory) {
      dominantCategory = String(fallbackCategory).trim();
    }

    console.log(`[XLSX Category Sync] Extracted Dominant Category: "${dominantCategory}" (Max Frequency Count: ${maxCount})`);

    // XLSX 업로드된 고유 정제 키워드 검색용 세트 가동 (OS 괄호 패턴 제거 및 공백 소문자화)
    const cleanedXlsxKeys = new Set<string>();
    keywords.forEach((item: any) => {
      const rawKw = item.keyword || '';
      if (!rawKw) return;
      const kwFullyCleaned = rawKw.replace(/\s*\(\d+\)/g, '').replace(/\s+/g, '').toLowerCase();
      cleanedXlsxKeys.add(kwFullyCleaned);
    });

    console.log('[XLSX Category Sync] Cleaned XLSX Unique Keywords Count:', cleanedXlsxKeys.size);

    if (cleanedXlsxKeys.size === 0) {
      console.log('[XLSX Category Sync] No valid keywords found in uploaded keywords. Skipping sync.');
      return res.json({ success: true, updated_count: 0, products_updated_count: 0 });
    }

    // =========================================================================
    // ② [2단계: DB keyword 1:1 대조 및 대표 카테고리 업데이트]
    // =========================================================================
    // 전체 키워드 정보를 가져와 1:1 매칭 처리를 수행합니다.
    const { data: allCsvRows, error: fetchError } = await supabase
      .from('search_csv_keywords')
      .select('*');

    if (fetchError) {
      console.error('[XLSX Category Sync] CSV Keywords Fetch error:', fetchError);
      return res.status(500).json({ error: fetchError.message });
    }

    console.log('[XLSX Category Sync] DB search_csv_keywords rows fetched:', allCsvRows ? allCsvRows.length : 0);

    const updatedKeywords: string[] = [];
    let pinpointUpdatedCount = 0;

    // DB에 완벽히 존재하는 키워드 중, 업로드 엑셀 세트에 1:1 매칭되는 행만 정밀 추출하여 1:1 단일 대상 업데이트(Single-Row Target Update) 가동
    for (const row of (allCsvRows || [])) {
      const rawDbKeyword = String(row.keyword || '');
      if (!rawDbKeyword) continue;

      const dbKwCleaned = rawDbKeyword.replace(/\s*\(\d+\)/g, '').replace(/\s+/g, '').toLowerCase();

      if (cleanedXlsxKeys.has(dbKwCleaned)) {
        // [1:1 매칭 성공한 경우]
        updatedKeywords.push(row.keyword);

        const sanitizedKeyword = row.keyword;
        if (!sanitizedKeyword) {
          console.warn('[XLSX Category Sync] Sanitized keyword is empty. Skipping pinpoint update.');
          continue;
        }

        // 개별 try-catch 트랩 설치를 통한 100% 무중단 견고성 확보
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
            console.error(`[XLSX Category Sync Pinpoint] DB update failed for keyword "${sanitizedKeyword}":`, singleUpdateError);
          } else {
            pinpointUpdatedCount++;
          }
        } catch (singleRowErr) {
          // 예외가 전체 프로세스를 무산시키지 않도록 격리 로깅 후 패스
          console.error(`[XLSX Category Sync Exception] Pinpoint single row failure for "${sanitizedKeyword}":`, singleRowErr);
        }
      }
    }

    console.log(`[XLSX Category Sync] Completed Pinpoint 1:1 Single-Row Updates. Success Count: ${pinpointUpdatedCount}`);

    // =========================================================================
    // ③ [3단계: products 테이블 락 해제 및 단일 타겟 상품의 related_keywords 저장 연산 조립]
    // =========================================================================
    let productsUpdatedCount = 0;
    if (targetCode && relatedKeywords) {
      const targetCodeStr = String(targetCode).trim();
      console.log(`[XLSX Category Sync] Preparing related_keywords update for target product [${targetCodeStr}]`);
      
      const updatePayload: any = {
        related_keywords: relatedKeywords,
        updated_at: new Date().toISOString()
      };

      const { error: productUpdateErr } = await supabase
        .from('products')
        .update(updatePayload)
        .eq('code', targetCodeStr);

      if (productUpdateErr) {
        console.error(`[XLSX Category Sync] Products related_keywords update failed for [${targetCodeStr}]:`, productUpdateErr);
        throw productUpdateErr;
      }
      productsUpdatedCount = 1;
    }

    console.log('[XLSX Category Sync] SUCCESSFULLY COMPLETE! UPDATED KEYWORDS:', updatedKeywords);
    console.log('[XLSX Category Sync] END =========================================');

    return res.json({
      success: true,
      updated_count: pinpointUpdatedCount,
      products_updated_count: productsUpdatedCount,
      matched_keywords: updatedKeywords
    });

  } catch (error: any) {
    console.error('[XLSX Category Sync] Atomic Concurrent Dual-Table Sync Exception:', error);
    return res.status(500).json({ error: error.message, details: error.details || null });
  }
});

// API Catch-all (Router level)
api.all('*', (req, res) => {
  console.log(`[API 404] Route not matched within /api: ${req.method} ${req.path}`);
  res.status(404).json({ error: 'API route not found in router' });
});

// Mount API Router EARLY
console.log('[SERVER] Mounting /api router...');
app.use('/api', api);
console.log('[SERVER] /api router mounted.');

// ==========================================
// 4. 🚨 전역 404 (API가 아닌 요청들)
// ==========================================
app.all('/api/*', (req, res) => {
  console.log(`[GLOBAL 404] API route not found: ${req.method} ${req.url}`);
  res.status(404).json({ success: false, error: 'API route not found' });
});

// 🚨 Global Error Handler (Must be after all routes)
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('[GLOBAL ERROR]', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error',
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// Route List Printer Function
function printRoutes(app: any) {
  console.log('\n=== [ROUTE LIST] Registered Endpoints ===');
  const routes: { method: string, path: string }[] = [];
  
  function processStack(stack: any[], prefix: string = '') {
    stack.forEach((middleware: any) => {
      if (middleware.route) {
        // Direct route
        const methods = Object.keys(middleware.route.methods).join(',').toUpperCase();
        routes.push({ method: methods, path: prefix + middleware.route.path });
      } else if (middleware.name === 'router') {
        // Nested router
        let newPrefix = prefix;
        if (middleware.regexp) {
          const match = middleware.regexp.toString().match(/^\/\^\\(\/.*?)\\\/\?\(\?=\\\/\|\$\)\/i$/);
          if (match) {
            newPrefix += match[1];
          }
        }
        processStack(middleware.handle.stack, newPrefix);
      }
    });
  }

  processStack(app._router.stack);
  
  routes.sort((a, b) => a.path.localeCompare(b.path)).forEach(r => {
    console.log(`${r.method.padEnd(7)} ${r.path}`);
  });
  console.log('==========================================\n');
}

// 5. 정적 파일 및 Vite 미들웨어 실행 (최하단)
async function startServer() {
  // Vite middleware
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const path = await import('path');
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
    printRoutes(app);
  });
}

// Vercel 환경이 아닐 때만 서버를 직접 실행 (Vercel은 export된 app을 자체적으로 실행함)
const isVercel = process.env.VERCEL === '1' || !!process.env.VERCEL;
const isDev = process.env.NODE_ENV !== 'production';

if (isDev && !isVercel) {
  startServer().catch(err => {
    console.error('[SERVER] Failed to start server:', err);
  });
}

export default app;
