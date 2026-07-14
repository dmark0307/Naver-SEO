-- ===============================================================
-- Supabase Server-side Architecture Optimization Script
-- ===============================================================

-- 1. 유사도 비교를 위한 확장 모듈 활성화
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. 비동기 작업 상태 추적 테이블
CREATE TABLE IF NOT EXISTS sync_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_type TEXT NOT NULL, -- 'SALES_COUNT_SYNC', 'SHOPMINE_UPLOAD'
    status TEXT NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'
    progress INT DEFAULT 0,
    result JSONB,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- [Snapshot] 매출 시점 매입가 고정을 위한 필드 추가
ALTER TABLE shopmine_sales ADD COLUMN IF NOT EXISTS purchase_unit_price NUMERIC DEFAULT 0;
ALTER TABLE shopmine_sales ADD COLUMN IF NOT EXISTS purchase_shipping_fee NUMERIC DEFAULT 0;
ALTER TABLE shopmine_sales ADD COLUMN IF NOT EXISTS actual_selling_price NUMERIC DEFAULT 0;

-- 3. 판매량 동기화 RPC (PL/pgSQL)
-- 브라우저로 데이터를 가져오지 않고 DB 내부에서 1시간 간격 로직을 적용하여 집계
CREATE OR REPLACE FUNCTION fn_sync_product_sales_count()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    updated_count INT := 0;
BEGIN
    -- 1시간 간격 중복 제거 로직을 적용한 판매량 집계 및 업데이트
    WITH sales_events AS (
        SELECT 
            market_product_id,
            seller_product_code,
            order_at,
            LAG(order_at) OVER (PARTITION BY market_product_id, seller_product_code ORDER BY order_at) as prev_order_at
        FROM shopmine_sales
        WHERE order_status NOT ILIKE ANY (ARRAY['%취소%', '%반품%', '%환불%', '%교환%', '%취소완료%', '%반품완료%', '%환불완료%'])
    ),
    counted_events AS (
        SELECT 
            market_product_id as code,
            COUNT(*) FILTER (WHERE prev_order_at IS NULL OR order_at - prev_order_at > interval '1 hour') as total_events
        FROM sales_events
        GROUP BY market_product_id
    )
    UPDATE products p
    SET 
        sales_count = ce.total_events,
        updated_at = now()
    FROM counted_events ce
    WHERE p.code = ce.code
    AND p.sales_count IS DISTINCT FROM ce.total_events;

    GET DIAGNOSTICS updated_count = ROW_COUNT;

    RETURN jsonb_build_object(
        'success', true,
        'updated_count', updated_count,
        'timestamp', now()
    );
END;
$$;

-- 5. 상품 정보 Upsert RPC (등록일자 date 보존 로직 포함)
-- INSERT 시에는 date를 포함하지만, ON CONFLICT 시에는 date를 업데이트하지 않음
CREATE OR REPLACE FUNCTION fn_upsert_products(product_data JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    updated_count INT;
BEGIN
    INSERT INTO products (
        code, date, cost, price, margin_rate, updated_at, 
        stats_period, total_inflow, 
        final_title, original_name, category, top_keyword, 
        channel_name, stats_account, avg_exposure_rank,
        last_exported_at, internal_code, mall, account,
        inflow_keywords, auto_keywords, related_keywords,
        filter_attributes, tags, sales_count
    )
    SELECT 
        item->>'code',
        COALESCE((item->>'date')::timestamptz, now()),
        (item->>'cost')::numeric,
        (item->>'price')::numeric,
        (item->>'margin_rate')::numeric,
        COALESCE((item->>'updated_at')::timestamptz, now()),
        item->>'stats_period',
        (item->>'total_inflow')::numeric,
        item->>'final_title',
        item->>'original_name',
        item->'category',
        item->'top_keyword',
        item->>'channel_name',
        item->>'stats_account',
        (item->>'avg_exposure_rank')::numeric,
        (item->>'last_exported_at')::timestamptz,
        item->>'internal_code',
        item->>'mall',
        item->>'account',
        item->'inflow_keywords',
        item->'auto_keywords',
        item->'related_keywords',
        item->'filter_attributes',
        item->'tags',
        (item->>'sales_count')::integer
    FROM jsonb_array_elements(product_data) AS item
    ON CONFLICT (code) DO UPDATE SET
        cost = EXCLUDED.cost,
        price = EXCLUDED.price,
        margin_rate = EXCLUDED.margin_rate,
        updated_at = EXCLUDED.updated_at,
        stats_period = EXCLUDED.stats_period,
        total_inflow = EXCLUDED.total_inflow,
        final_title = EXCLUDED.final_title,
        original_name = EXCLUDED.original_name,
        category = EXCLUDED.category,
        top_keyword = EXCLUDED.top_keyword,
        channel_name = EXCLUDED.channel_name,
        stats_account = EXCLUDED.stats_account,
        avg_exposure_rank = EXCLUDED.avg_exposure_rank,
        last_exported_at = EXCLUDED.last_exported_at,
        internal_code = EXCLUDED.internal_code,
        mall = EXCLUDED.mall,
        account = EXCLUDED.account,
        inflow_keywords = EXCLUDED.inflow_keywords,
        auto_keywords = EXCLUDED.auto_keywords,
        related_keywords = EXCLUDED.related_keywords,
        filter_attributes = EXCLUDED.filter_attributes,
        tags = EXCLUDED.tags,
        sales_count = EXCLUDED.sales_count;
        -- date 컬럼은 DO UPDATE SET 절에서 제외하여 최초 등록일 보존

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    
    RETURN jsonb_build_object('upserted_count', updated_count);
END;
$$;

-- 5. 요약 테이블 (Materialized View) 검토
-- 대시보드 조회 속도 최적화를 위해 수만 건의 연산 결과를 미리 저장해두는 뷰
-- 필요 시 아래와 같이 생성하여 사용:
-- CREATE MATERIALIZED VIEW mv_daily_sales_summary AS
-- SELECT 
--   date_trunc('day', order_at) as sale_date,
--   mall_name,
--   SUM(actual_payment_amount) as total_revenue,
--   SUM(purchase_total_price) as total_cost
-- FROM shopmine_sales
-- GROUP BY 1, 2;
-- CREATE INDEX idx_mv_sale_date ON mv_daily_sales_summary(sale_date);

-- 4. 매입 단가 매핑 및 연산 RPC
-- 업로드된 데이터를 JSONB로 받아 DB 내부에서 최신 단가와 매핑 및 연산 수행
CREATE OR REPLACE FUNCTION fn_process_shopmine_mapping(upload_data JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    rec RECORD;
    mapped_count INT := 0;
    current_item JSONB;
    latest_price_rec RECORD;
    final_purchase_price NUMERIC;
    final_purchase_shipping_fee NUMERIC;
    final_supplier TEXT;
    order_timestamp TIMESTAMPTZ;
BEGIN
    -- 트랜잭션 내에서 처리 (원자성 보장)
    FOR current_item IN SELECT * FROM jsonb_array_elements(upload_data)
    LOOP
        order_timestamp := (current_item->>'order_at')::timestamptz;

        -- 1단계: SKU 일치 필터링 (최신 기록 우선)
        -- 2단계: 옵션명 100% 텍스트 대조 (정규화 적용)
        SELECT unit_price, vendor_name INTO latest_price_rec
        FROM purchase_records
        WHERE TRIM(UPPER(internal_sku)) = TRIM(UPPER(current_item->>'seller_product_code'))
        AND regexp_replace(regexp_replace(order_option, '\([^)]*\)|\[[^\]]*\]', '', 'g'), '[^a-zA-Z0-9가-힣]', '', 'g') 
            = regexp_replace(regexp_replace(current_item->>'options', '\([^)]*\)|\[[^\]]*\]', '', 'g'), '[^a-zA-Z0-9가-힣]', '', 'g')
        ORDER BY created_at DESC
        LIMIT 1;

        -- 3단계: 부분 일치 Fallback (DB 텍스트가 엑셀 텍스트에 포함되는지)
        IF latest_price_rec IS NULL THEN
            SELECT unit_price, vendor_name INTO latest_price_rec
            FROM purchase_records
            WHERE TRIM(UPPER(internal_sku)) = TRIM(UPPER(current_item->>'seller_product_code'))
            AND regexp_replace(regexp_replace(current_item->>'options', '\([^)]*\)|\[[^\]]*\]', '', 'g'), '[^a-zA-Z0-9가-힣]', '', 'g')
                LIKE '%' || regexp_replace(regexp_replace(order_option, '\([^)]*\)|\[[^\]]*\]', '', 'g'), '[^a-zA-Z0-9가-힣]', '', 'g') || '%'
            ORDER BY created_at DESC
            LIMIT 1;
        END IF;

        -- 결과 할당 및 연산
        final_purchase_price := COALESCE(latest_price_rec.unit_price, 0);
        -- 위탁상품 배송비: 엑셀 원본 우선 적용 (DB 참조 금지)
        IF (current_item->>'shipping_fee_type') = '무료' THEN
            final_purchase_shipping_fee := 0;
        ELSE
            final_purchase_shipping_fee := COALESCE((current_item->>'shipping_fee')::numeric, 0);
        END IF;
        final_supplier := COALESCE(latest_price_rec.vendor_name, '-');

        -- shopmine_sales 테이블 Upsert
        INSERT INTO shopmine_sales (
            order_unique_code, unit_price, supplier, updated_at, order_no, order_at, 
            mall_name, mall_id, account_alias, seller_product_code, product_name, 
            quantity, settlement_expected_amount, actual_payment_amount, 
            actual_payment_with_shipping, market_fee_amount, shipping_fee, shipping_fee_type,
            order_status, market_product_id, total_order_amount, options, 
            discount_amount, product_url, fee_rate, order_count, 
            sm_sales_count, courier, tracking_number, cost_status,
            purchase_unit_price, purchase_shipping_fee, actual_selling_price
        ) VALUES (
            current_item->>'order_unique_code',
            final_purchase_price,
            final_supplier,
            now(),
            current_item->>'order_no',
            order_timestamp,
            current_item->>'mall_name',
            current_item->>'mall_id',
            current_item->>'account_alias',
            current_item->>'seller_product_code',
            current_item->>'product_name',
            (current_item->>'quantity')::integer,
            (current_item->>'settlement_expected_amount')::numeric,
            (current_item->>'actual_payment_amount')::numeric,
            (current_item->>'actual_payment_with_shipping')::numeric,
            (current_item->>'market_fee_amount')::numeric,
            (current_item->>'shipping_fee')::numeric,
            current_item->>'shipping_fee_type',
            current_item->>'order_status',
            current_item->>'market_product_id',
            (current_item->>'total_order_amount')::numeric,
            current_item->>'options',
            (current_item->>'discount_amount')::numeric,
            current_item->>'product_url',
            (current_item->>'fee_rate')::numeric,
            (current_item->>'order_count')::integer,
            (current_item->>'sm_sales_count')::integer,
            current_item->>'courier',
            current_item->>'tracking_number',
            current_item->>'cost_status',
            final_purchase_price,
            final_purchase_shipping_fee,
            (current_item->>'actual_selling_price')::numeric
        )
        ON CONFLICT (order_unique_code) DO UPDATE SET
            unit_price = EXCLUDED.unit_price,
            purchase_unit_price = EXCLUDED.purchase_unit_price,
            purchase_shipping_fee = EXCLUDED.purchase_shipping_fee,
            actual_selling_price = EXCLUDED.actual_selling_price,
            supplier = EXCLUDED.supplier,
            updated_at = EXCLUDED.updated_at,
            order_no = EXCLUDED.order_no,
            order_at = EXCLUDED.order_at,
            mall_name = EXCLUDED.mall_name,
            mall_id = EXCLUDED.mall_id,
            account_alias = EXCLUDED.account_alias,
            seller_product_code = EXCLUDED.seller_product_code,
            product_name = EXCLUDED.product_name,
            quantity = EXCLUDED.quantity,
            settlement_expected_amount = EXCLUDED.settlement_expected_amount,
            actual_payment_amount = EXCLUDED.actual_payment_amount,
            actual_payment_with_shipping = EXCLUDED.actual_payment_with_shipping,
            market_fee_amount = EXCLUDED.market_fee_amount,
            shipping_fee = EXCLUDED.shipping_fee,
            shipping_fee_type = EXCLUDED.shipping_fee_type,
            order_status = EXCLUDED.order_status,
            market_product_id = EXCLUDED.market_product_id,
            total_order_amount = EXCLUDED.total_order_amount,
            options = EXCLUDED.options,
            discount_amount = EXCLUDED.discount_amount,
            product_url = EXCLUDED.product_url,
            fee_rate = EXCLUDED.fee_rate,
            order_count = EXCLUDED.order_count,
            sm_sales_count = EXCLUDED.sm_sales_count,
            courier = EXCLUDED.courier,
            tracking_number = EXCLUDED.tracking_number,
            cost_status = EXCLUDED.cost_status;

        mapped_count := mapped_count + 1;
    END LOOP;

    RETURN jsonb_build_object('processed', mapped_count);
END;
$$;

-- 6. 사용자 관리 테이블 (Cloud DB Sync)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'USER',
    allowed_menus TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- RLS 설정 (필요 시)
-- ALTER TABLE users ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "Allow all for authenticated" ON users FOR ALL TO authenticated USING (true);

-- 7. 통합 광고 데이터 테이블 (Ad Performance logs)
CREATE TABLE IF NOT EXISTS ad_performance_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    market TEXT NOT NULL, -- 마켓명 (예: '지마켓', '11번가', '스마트스토어')
    ad_type TEXT NOT NULL, -- 광고종류 (예: '파워클릭', 'AI매출업', '검색광고', '디스플레이광고')
    account TEXT NOT NULL, -- 계정명 (예: 'apasoo', 'apachii')
    report_date DATE NOT NULL, -- 광고 리포트 상의 타겟 일자
    impressions INT DEFAULT 0, -- 노출수
    clicks INT DEFAULT 0, -- 클릭수
    cost NUMERIC DEFAULT 0, -- 총비용/광고비
    conversions INT DEFAULT 0, -- 전환수/구매수/주문수
    conversion_revenue NUMERIC DEFAULT 0, -- 전환매출액/구매금액
    raw_metrics JSONB DEFAULT '{}'::jsonb, -- 마켓/광고별 고유 지표 객체 저장소
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 인덱스 생성 (성능 최적화)
CREATE INDEX IF NOT EXISTS idx_ad_perf_market_account ON ad_performance_logs(market, account);
CREATE INDEX IF NOT EXISTS idx_ad_perf_report_date ON ad_performance_logs(report_date);

-- 8. 광고 요약 통계 집계 RPC 함수
CREATE OR REPLACE FUNCTION get_ad_summary_stats(
    p_start_date TEXT DEFAULT NULL,
    p_end_date TEXT DEFAULT NULL,
    p_market TEXT DEFAULT NULL,
    p_account TEXT DEFAULT NULL,
    p_ad_type TEXT DEFAULT NULL
)
RETURNS TABLE (
    total_cost NUMERIC,
    total_revenue NUMERIC,
    total_conversions BIGINT
) 
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COALESCE(SUM(cost), 0)::NUMERIC as total_cost,
        COALESCE(SUM(conversion_revenue), 0)::NUMERIC as total_revenue,
        COALESCE(SUM(conversions), 0)::BIGINT as total_conversions
    FROM ad_performance_logs
    WHERE (p_start_date IS NULL OR p_start_date = '' OR report_date >= p_start_date::DATE)
      AND (p_end_date IS NULL OR p_end_date = '' OR report_date <= p_end_date::DATE)
      AND (p_market IS NULL OR p_market = '' OR p_market = '전체' OR market = p_market)
      AND (p_account IS NULL OR p_account = '' OR p_account = '전체' OR account = p_account)
      AND (p_ad_type IS NULL OR p_ad_type = '' OR p_ad_type = '전체' OR ad_type = p_ad_type);
END;
$$;

-- 9. 고유 필터 조합 호출 RPC 함수
CREATE OR REPLACE FUNCTION get_unique_filters()
RETURNS TABLE (
    market TEXT,
    account TEXT,
    ad_type TEXT
) 
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT DISTINCT 
        COALESCE(ad_performance_logs.market, '')::TEXT,
        COALESCE(ad_performance_logs.account, '')::TEXT,
        COALESCE(ad_performance_logs.ad_type, '')::TEXT
    FROM ad_performance_logs
    ORDER BY 1, 2, 3;
END;
$$;


-- 10. search_csv_keywords 테이블의 area_value_order 컬럼을 text 타입으로 변경
ALTER TABLE search_csv_keywords ALTER COLUMN area_value_order TYPE text USING area_value_order::text;

-- 11. search_csv_keywords 테이블에 키워드 발굴(is_discovered, target_product_code) 연동 필드 생성
ALTER TABLE search_csv_keywords ADD COLUMN IF NOT EXISTS is_discovered BOOLEAN DEFAULT false;
ALTER TABLE search_csv_keywords ADD COLUMN IF NOT EXISTS target_product_code TEXT;


