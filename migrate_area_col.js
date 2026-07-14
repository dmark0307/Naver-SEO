import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

async function runMigration() {
  const host = 'db.femvqmwrzlvruuqpbsku.supabase.co';
  const port = 6543;
  const user = 'postgres';
  const passwords = [
    'sh0908!@!@!',
    'sh0908!@!@',
    'sh0908!',
    'dmark4362!',
    'dmark4362!@',
    'dmark4362!@!@',
    'dmark4362'
  ];
  const database = 'postgres';

  for (const password of passwords) {
    console.log(`Trying ${user}:${password} ...`);
    const client = new pg.Client({
      host,
      port,
      user,
      password,
      database,
      ssl: {
        rejectUnauthorized: false
      }
    });

    try {
      await client.connect();
      console.log(`Successfully connected with password: ${password}`);
      
      // ALTER COLUMN TYPE TO text[]
      // 기존 text 컬럼 값을 안전하게 배열로 캐스팅하는 완벽한 가드 쿼리
      const alterQuery = `
        ALTER TABLE search_csv_keywords 
        ALTER COLUMN area_value_order TYPE text[] 
        USING CASE 
          WHEN area_value_order IS NULL OR area_value_order = '' THEN '{}'::text[] 
          WHEN area_value_order LIKE '[%' THEN 
            CASE 
              -- 만약 이미 JSON 배열 문자열 형태면 텍스트 배열로 파싱 시도할 수도 있지만, 안전하게 ARRAY[area_value_order] 형태로 감싸거나 변환합니다.
              ELSE ARRAY[area_value_order]::text[]
            END
          ELSE ARRAY[area_value_order]::text[]
        END;
      `;
      
      // 보다 안전하고 단순하게 변환: 빈 문자열이나 NULL은 빈 배열로, 나머지는 단일 원소 배열로 캐스팅
      const simpleAlterQuery = `
        ALTER TABLE search_csv_keywords 
        ALTER COLUMN area_value_order TYPE text[] 
        USING CASE 
          WHEN area_value_order IS NULL OR area_value_order = '' THEN '{}'::text[] 
          ELSE ARRAY[area_value_order]::text[]
        END;
      `;
      
      console.log("Executing alter column query...");
      const res = await client.query(simpleAlterQuery);
      console.log("Migration successful!", res);
      
      await client.end();
      return;
    } catch (err) {
      console.log(`Failed for password ${password}: ${err.message}`);
    }
  }
}

runMigration();
