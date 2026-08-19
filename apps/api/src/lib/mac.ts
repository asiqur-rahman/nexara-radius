import { BadRequest } from "./errors.js";

export function normalizeMac(input: string): string {
  const compact = compactMac(input);
  if (!compact) {
    throw BadRequest("MAC address must contain 12 hexadecimal digits");
  }
  return compact;
}

/** Parse a MAC for RADIUS hooks. Empty / garbage returns null (do not throw). */
export function tryNormalizeMac(input: string | undefined | null): string | null {
  if (!input) return null;
  return compactMac(input);
}

function compactMac(input: string): string | null {
  const compact = input.replace(/[:.\s-]/g, "").toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(compact)) return null;
  return compact.match(/.{2}/g)!.join(":");
}
