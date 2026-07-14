export const toStrictStringCode = (val: any): string => {
  if (val === undefined || val === null || val === '') return "";
  
  let strVal = String(val).trim();
  
  // Handle Scientific Notation (Safety Guard)
  // SmartStore product numbers are long and often get converted to scientific notation in Excel
  if (strVal.toLowerCase().includes('e')) {
    const numVal = Number(val);
    if (!isNaN(numVal) && isFinite(numVal)) {
      try {
        // Use BigInt for precision with large integers
        strVal = BigInt(Math.floor(numVal)).toString();
      } catch {
        strVal = numVal.toFixed(0);
      }
    }
  }
  
  // [Task] internal_sku 원본 보존 (과잉 가공 금지)
  // 기존의 .split('.')[0].replace(/[^0-9]/g, '') 는 대시(-)나 문자열을 유실시킴.
  // 원본 문자열을 최대한 보존하되 공백만 제거함.
  return strVal;
};

export const cleanCategory = (val: any): string => {
  if (!val) return "";
  
  let strVal = String(val);
  
  // 1. Split by '>'
  const parts = strVal.split('>').map(p => p.trim()).filter(p => p.length > 0);
  
  // 2. Filter out common intent tags (쇼핑성, 정보성)
  const intentTags = ['쇼핑성', '정보성'];
  const cleanedParts = parts.filter(p => !intentTags.includes(p));
  
  // 3. Join with '>'
  let result = cleanedParts.join('>');
  
  // 4. Final sanitization (trailing symbols)
  result = result.replace(/[> \-*]+$/, '');
  
  return result;
};
