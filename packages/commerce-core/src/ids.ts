import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32, no ambiguous chars

/** Sortable-ish id: 9 char time prefix + 10 random chars, with a type prefix. */
export function newId(prefix: string): string {
  const t = Date.now().toString(32).toUpperCase().padStart(9, "0");
  const bytes = randomBytes(10);
  let rnd = "";
  for (const b of bytes) rnd += ALPHABET[b % 32];
  return `${prefix}_${t}${rnd}`;
}

/** Human order number like AC-7F3K9Q (checked for uniqueness by caller). */
export function newOrderNumber(storePrefix = "AC"): string {
  const bytes = randomBytes(6);
  let s = "";
  for (const b of bytes) s += ALPHABET[b % 32];
  return `${storePrefix}-${s}`;
}

const COMBINING_MARKS = /[̀-ͯ]/g;

export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
