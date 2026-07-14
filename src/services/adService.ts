import { supabase } from '../supabaseClient';

/**
 * 광고 성과 로그 데이터를 안전하게 가져오는 서비스 함수
 * 테이블이 누락되거나 에러가 발생해도 절대 크래시를 일으키지 않고 빈 배열을 반환합니다.
 */
export const fetchAds = async (): Promise<any[]> => {
  try {
    const { data, error } = await supabase
      .from('ad_performance_logs')
      .select('*')
      .order('report_date', { ascending: true });
      
    if (error) {
      console.warn('Ad table relation missing, silently bypassing:', error.message);
      return []; // 절대 throw 하지 않고 빈 배열 반환
    }
    return data || [];
  } catch (err: any) {
    console.warn('Silent catch in adService.ts:', err);
    return [];
  }
};
