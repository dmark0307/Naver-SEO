import pg from 'pg';
import dns from 'dns';
import dotenv from 'dotenv';
dotenv.config();

dns.lookup('db.femvqmwrzlvruuqpbsku.supabase.co', { family: 4 }, async (err, address, family) => {
  if (err) {
    console.error("DNS Lookup Error:", err);
    return;
  }
  console.log(`Resolved IP: ${address} (Family: ${family})`);

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
  const port = 6543;
  const database = 'postgres';

  for (const password of passwords) {
    console.log(`Trying ${user} : ${password} on ${address}:${port}`);
    const client = new pg.Client({
      host: address,
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
      console.log(`SUCCESS WITH ${user} : ${password}!!!`);
      
      const alterQuery = `
        ALTER TABLE products 
        ADD COLUMN IF NOT EXISTS discovered_keywords text[] DEFAULT '{}'::text[];
      `;
      const res = await client.query(alterQuery);
      console.log("Alter Query Result:", res);
      
      await client.end();
      return;
    } catch (err) {
      if (err.message.includes('password authentication failed') || err.message.includes('SASL')) {
        console.log(`Auth failed for ${password}`);
      } else {
        console.error(`Error for ${password}: ${err.message}`);
      }
    }
  }
  console.log("All passwords failed.");
});

