/**
 * Number formatting with a FIXED Latin-digit locale.
 *
 * `toLocaleString()` with no argument follows the OS locale, so on a
 * fa-IR Windows install every count in the app came out in Persian digits
 * (۷۲٬۰۰۰). The project rule is that numbers stay Latin and LTR in every
 * language — a Persian-digit price cannot be pasted into a broker
 * statement — so all numeric formatting must go through here instead of
 * calling toLocaleString() bare.
 */
export function latinNum(n: number): string {
  return n.toLocaleString("en-US");
}
