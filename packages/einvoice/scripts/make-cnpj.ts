/** Compute a valid CNPJ for a 12-digit base, for use in fixtures. */
function checkDigit(digits: string, weights: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += Number(digits[i]) * weights[i]!;
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

export function makeCnpj(base12: string): string {
  const b = base12.padStart(12, '0');
  const d1 = checkDigit(b, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = checkDigit(`${b}${d1}`, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${b}${d1}${d2}`;
}

console.log('987654320001 ->', makeCnpj('987654320001'));
console.log('112223330001 ->', makeCnpj('112223330001'));
console.log('123456780001 ->', makeCnpj('123456780001'));