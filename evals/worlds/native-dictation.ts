import type { Place, Seed } from "@openwork/env";
import { workbotContinuity } from "./workbot-continuity.ts";

/** Real browser composer; UA selects native instructions only. No fake microphone
 * or transcript is injected, and this does not claim native OS recognition. */
export async function nativeDictation(seed: Seed, options: { place: Place }) {
  const base = await workbotContinuity(seed, options);
  try {
    await base.web.client.send("Emulation.setUserAgentOverride", {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    });
    return base;
  } catch (error) { await base[Symbol.asyncDispose](); throw error; }
}
