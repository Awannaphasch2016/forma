export const WORKSPACE = "/workspace";
export const SANDBOX_TIMEOUT = 30 * 60_000;
export const IDLE_MINUTES = 10;

const APP_KEYS = [
  "DATABASE_URL",
  "APP_PASSWORD",
  "AUTH_SECRET",
  "CRON_SECRET",
] as const;

export const OPENAI_CONFIG_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_EXECUTOR_API_KEY",
  "OPENAI_AGENT_ID",
  "OPENAI_WEBHOOK_SECRET",
] as const;

export function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. See .env.example.`);
  return value;
}

// OpenRouter is enough on its own. The Agents credentials stay the path
// when that key is absent and all four OpenAI names are set.
export function providerMode(): "openai" | "openrouter" | "unconfigured" {
  if (process.env.OPENROUTER_API_KEY?.trim()) return "openrouter";
  if (OPENAI_CONFIG_KEYS.every((key) => process.env[key])) return "openai";
  return "unconfigured";
}

export function missingConfig(): string[] {
  const missing: string[] = APP_KEYS.filter((key) => !process.env[key]);
  if (providerMode() !== "unconfigured") return missing;
  return missing.concat(OPENAI_CONFIG_KEYS.filter((key) => !process.env[key]));
}
