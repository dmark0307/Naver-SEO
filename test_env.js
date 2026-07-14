console.log("Keys:", Object.keys(process.env).filter(k => k.includes("SUPABASE") || k.includes("DATABASE")));
