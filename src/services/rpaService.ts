import { chromium, Page } from 'playwright';
import * as XLSX from 'xlsx';
import { SupabaseClient } from '@supabase/supabase-js';
import path from 'path';
import fs from 'fs';
import dayjs from 'dayjs';

export interface RPAResult {
  success: boolean;
  count: number;
  message: string;
  error?: string;
}

/**
 * [RPA] Ownerclan Order/Purchase Data Collection
 */
export async function runOwnerclanRPA(supabase: SupabaseClient, targetDate?: string): Promise<RPAResult> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    const userId = process.env.OWNERCLAN_ID;
    const userPw = process.env.OWNERCLAN_PW;

    if (!userId || !userPw) {
      throw new Error('Ownerclan credentials (ID/PW) are missing in environment variables.');
    }

    console.log('[RPA] Starting Ownerclan Login...');
    await page.goto('https://ownerclan.com/V2/member/login.php');

    // Login
    await page.fill('input[name="m_id"]', userId);
    await page.fill('input[name="m_passwd"]', userPw);
    await page.waitForTimeout(1000 + Math.random() * 1000);
    await page.click('input[type="submit"], button.btn_login, .btn_login_submit'); // Adjust selector based on actual site

    // Check login success (e.g., check if redirected or logout button exists)
    await page.waitForLoadState('networkidle');
    if (page.url().includes('login.php')) {
      // Still on login page, might be an error or captcha
      const errorMsg = await page.innerText('body').catch(() => '');
      if (errorMsg.includes('캡차') || errorMsg.includes('CAPTCHA')) {
        throw new Error('CAPTCHA detected during login. Manual intervention required.');
      }
      throw new Error('Login failed. Please check credentials.');
    }

    console.log('[RPA] Login Success. Navigating to Order List...');
    // Navigate to Order List
    await page.goto('https://ownerclan.com/V2/service/orderList.php');
    await page.waitForLoadState('networkidle');

    // Set Date Filter
    const date = targetDate || dayjs().subtract(1, 'day').format('YYYY-MM-DD');
    console.log(`[RPA] Setting date filter to: ${date}`);
    
    // Adjust these selectors based on Ownerclan's actual DOM
    // Usually they have start_date and end_date inputs
    await page.fill('input[name="s_date"]', date).catch(() => {});
    await page.fill('input[name="e_date"]', date).catch(() => {});
    
    await page.waitForTimeout(500);
    await page.click('#btn_search, .btn_search_submit').catch(() => {});
    await page.waitForLoadState('networkidle');

    // Download Excel
    console.log('[RPA] Triggering Excel Download...');
    const downloadPromise = page.waitForEvent('download');
    
    // Find the Excel download button. Common selectors: .btn_excel, #btn_excel_down
    await page.click('.btn_excel_down, #btn_excel, a:has-text("엑셀")').catch(async () => {
      // Fallback: try to find any button with "엑셀" text
      await page.click('button:has-text("엑셀")');
    });

    const download = await downloadPromise;
    const tempPath = path.join(process.cwd(), 'tmp', `ownerclan_${Date.now()}.xlsx`);
    
    // Ensure tmp directory exists
    if (!fs.existsSync(path.join(process.cwd(), 'tmp'))) {
      fs.mkdirSync(path.join(process.cwd(), 'tmp'));
    }

    await download.saveAs(tempPath);
    console.log(`[RPA] Downloaded to: ${tempPath}`);

    // Parse Excel
    const workbook = XLSX.readFile(tempPath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rawData = XLSX.utils.sheet_to_json(worksheet) as any[];

    console.log(`[RPA] Parsed ${rawData.length} rows from Excel.`);

    // Map to purchase_records
    // NOTE: Header names are guesses based on typical B2B sites. Adjust as needed.
    const mappedData = rawData.map(row => {
      // Try to find common header names
      const orderId = row['주문번호'] || row['주문코드'] || row['Order ID'] || '';
      const productName = row['상품명'] || row['Product Name'] || '';
      const unitPrice = parseInt(String(row['공급가'] || row['매입가'] || row['결제금액'] || 0).replace(/[^0-9]/g, '')) || 0;
      const recordDate = row['주문일자'] || row['결제일자'] || date;
      const optionName = row['옵션'] || row['선택사항'] || '';

      return {
        vendor_order_id: String(orderId),
        product_name: productName,
        order_option: optionName,
        unit_price: unitPrice,
        record_date: dayjs(recordDate).format('YYYY-MM-DD'),
        vendor_name: '오너클랜',
        source_type: 'RPA_AUTO',
        created_at: new Date().toISOString()
      };
    }).filter(item => item.vendor_order_id && item.unit_price > 0);

    console.log(`[RPA] Filtered to ${mappedData.length} valid records for DB.`);

    if (mappedData.length > 0) {
      // Upsert to Supabase
      // Assuming vendor_order_id is a unique constraint or we use it for conflict resolution
      const { error: upsertError } = await supabase
        .from('purchase_records')
        .upsert(mappedData, { onConflict: 'vendor_order_id' });

      if (upsertError) {
        throw upsertError;
      }
    }

    // Cleanup
    fs.unlinkSync(tempPath);
    await browser.close();

    return {
      success: true,
      count: mappedData.length,
      message: `Successfully collected and saved ${mappedData.length} records from Ownerclan.`
    };

  } catch (err: any) {
    console.error('[RPA] Error:', err);
    await browser.close();
    return {
      success: false,
      count: 0,
      message: 'RPA execution failed.',
      error: err.message
    };
  }
}
