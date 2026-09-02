import { loadEnv } from "@srectl/core";
import { InMemoryRunner, LlmAgent } from "@google/adk";

const env = loadEnv();
if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set — see Gate 1.2");

const MODEL = process.argv[2] ?? "gemini-3.5-flash";
const MAX_ATTEMPTS = 3;

interface Attempt {
  attempt: number;
  latencyMs: number;
  errorCode?: string;
  errorMessage?: string;
  text: string;
  usage: unknown;
}

async function ask(): Promise<Attempt> {
  const agent = new LlmAgent({
    name: "gate_check",
    model: MODEL,
    description: "Confirms the ADK runtime and API key work end to end.",
    instruction: "Answer in one short sentence. Do not use lists.",
  });

  const runner = new InMemoryRunner({ agent });
  const session = await runner.sessionService.createSession({
    appName: runner.appName,
    userId: "gate-1-2",
  });

  const started = performance.now();
  let text = "";
  let usage: unknown = null;
  let errorCode: string | undefined;
  let errorMessage: string | undefined;

  for await (const event of runner.runAsync({
    userId: session.userId,
    sessionId: session.id,
    newMessage: { role: "user", parts: [{ text: "In one sentence: what is mutation testing?" }] },
  })) {
    // An error event carries no content. Reporting "" here instead of the
    // error is how a broken key would look identical to an overloaded model.
    if (event.errorCode) {
      errorCode = String(event.errorCode);
      errorMessage = event.errorMessage;
    }
    for (const part of event.content?.parts ?? []) {
      if (part.text) text += part.text;
    }
    if (event.usageMetadata) usage = event.usageMetadata;
  }

  return {
    attempt: 0,
    latencyMs: Math.round(performance.now() - started),
    ...(errorCode ? { errorCode } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    text: text.trim(),
    usage,
  };
}

const history: Attempt[] = [];
let final: Attempt | undefined;

for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
  const result = { ...(await ask()), attempt: i };
  history.push(result);

  if (result.text) {
    final = result;
    break;
  }
  // 503 / 429 are upstream load, not configuration. Back off and retry.
  if (i < MAX_ATTEMPTS) {
    const wait = 2000 * i;
    console.error(`attempt ${i} failed (${result.errorCode ?? "empty"}), retrying in ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

const ok = Boolean(final?.text);
console.log(JSON.stringify({ ok, model: MODEL, attempts: history, reply: final?.text ?? null }, null, 2));
if (!ok) process.exitCode = 1;
