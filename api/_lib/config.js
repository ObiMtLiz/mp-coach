// All the settings you might want to change live here or in Vercel environment variables.

export const MODEL = process.env.MODEL || "claude-opus-5-5";
export const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 4000);

// Price per million tokens (input, output), used to count each client's spend.
// If you change MODEL to one not listed, set PRICE_INPUT_PER_MTOK and PRICE_OUTPUT_PER_MTOK.
const KNOWN_PRICES = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
  "claude-haiku-4-5-20251001": [1, 5],
};
const known = KNOWN_PRICES[MODEL] || [4, 20]; // unknown model: count conservatively
export const PRICE_IN = Number(process.env.PRICE_INPUT_PER_MTOK || known[0]);
export const PRICE_OUT = Number(process.env.PRICE_OUTPUT_PER_MTOK || known[1]);

// Safety limits (dollars).
export const DAILY_CAP = Number(process.env.DAILY_CAP_PER_CLIENT || 5);          // per client per day
export const GLOBAL_MONTHLY_CAP = Number(process.env.GLOBAL_MONTHLY_CAP || 300); // whole app per month
export const WARN_AT = Number(process.env.WARN_AT || 0.8);                        // warn at 80% of the cap
export const REQUESTS_PER_MINUTE = Number(process.env.REQUESTS_PER_MINUTE || 12);

// Defaults offered on the admin page when you add a client or team (dollars of model usage per license year).
export const DEFAULT_INDIVIDUAL_CAP = Number(process.env.DEFAULT_INDIVIDUAL_CAP || 150);
export const DEFAULT_TEAM_CAP = Number(process.env.DEFAULT_TEAM_CAP || 1500);

export function costOf(usage) {
  const inTok =
    (usage.input_tokens || 0) +
    1.25 * (usage.cache_creation_input_tokens || 0) +
    0.1 * (usage.cache_read_input_tokens || 0);
  return (inTok * PRICE_IN + (usage.output_tokens || 0) * PRICE_OUT) / 1e6;
}

export function today() { return new Date().toISOString().slice(0, 10); }
export function thisMonth() { return new Date().toISOString().slice(0, 7); }
