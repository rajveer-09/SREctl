import { GoogleGenAI } from "@google/genai";

/**
 * Cheap local estimate, used for budget decisions while assembling.
 *
 * Calibrated against countTokens on a real bundle: chars/4 is the usual rule
 * of thumb for prose but underestimated this repository's TypeScript by ~28%,
 * because identifiers, punctuation and indentation tokenize densely. 3.0 sits
 * deliberately on the conservative side, so a budget check errs toward
 * dropping an item rather than overshooting the model's context window.
 *
 * It is still not authoritative. The bundle reports countTokens alongside it
 * so the error stays visible instead of being quietly trusted.
 */
export const CHARS_PER_TOKEN = 3.0;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export async function countTokens(apiKey: string, model: string, text: string): Promise<number> {
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.countTokens({
    model,
    contents: [{ role: "user", parts: [{ text }] }],
  });
  return res.totalTokens ?? 0;
}
