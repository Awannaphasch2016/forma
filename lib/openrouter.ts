import OpenAI from "openai";
import { required, WORKSPACE } from "./config";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4.1-mini";
const MAX_STEPS = 6;
const MAX_FILE_CHARS = 100_000;

const BLOCKED = new Set([
  "AGENTS.md",
  "next.config.ts",
  "next.config.mjs",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "postcss.config.mjs",
  ".studio-initialized",
]);

export type WorkspaceFiles = {
  writeFiles(files: { path: string; content: Buffer }[]): Promise<unknown>;
  runCommand(command: { cmd: string; args: string[] }): Promise<{
    exitCode: number | null;
    stdout: () => Promise<string>;
  }>;
};

type ToolCall = {
  id: string;
  function: {
    name: string;
    arguments: string | Record<string, unknown>;
  };
};

export type ChatClient = {
  chat: {
    completions: {
      create(body: {
        model: string;
        messages: unknown[];
        tools: unknown;
        temperature: number;
        max_tokens: number;
      }): Promise<{
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: ToolCall[];
          };
        }>;
      }>;
    };
  };
};

export function openRouterModel() {
  return process.env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;
}

export function openRouterClient(): ChatClient {
  return new OpenAI({
    apiKey: required("OPENROUTER_API_KEY"),
    baseURL: OPENROUTER_BASE_URL,
    maxRetries: 0,
    timeout: 45_000,
  }) as ChatClient;
}

export function openRouterError(error: unknown) {
  if (error instanceof OpenAI.APIError) {
    return `OpenRouter request failed (${error.status ?? "connection"}).`;
  }
  return error instanceof Error ? error.message : "OpenRouter request failed";
}

export function workspaceFilePath(input: string) {
  const trimmed = String(input ?? "")
    .trim()
    .replaceAll("\\", "/");
  const relative = trimmed.startsWith(`${WORKSPACE}/`)
    ? trimmed.slice(WORKSPACE.length + 1)
    : trimmed.replace(/^\/+/, "");
  const parts = relative.split("/");
  if (
    !relative ||
    parts.some((part) => !part || part === "." || part === "..") ||
    parts[0]?.startsWith(".") ||
    relative.includes("node_modules/")
  ) {
    throw new Error("That file is outside the workspace.");
  }
  if (BLOCKED.has(relative)) {
    throw new Error(`${relative} is managed by the studio.`);
  }
  return { relative, absolute: `${WORKSPACE}/${relative}` };
}

const tools = [
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or replace one file in the Next.js app.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read one file from the Next.js app.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
];

function argumentsOf(value: string | Record<string, unknown>) {
  if (typeof value === "string") {
    return JSON.parse(value) as Record<string, unknown>;
  }
  return value ?? {};
}

export async function applyTool(
  sandbox: WorkspaceFiles,
  name: string,
  args: Record<string, unknown>,
) {
  if (name === "write_file") {
    const content = args.content;
    if (typeof args.path !== "string" || typeof content !== "string") {
      throw new Error("write_file needs a path and content.");
    }
    if (content.length > MAX_FILE_CHARS) throw new Error("File is too large.");
    const file = workspaceFilePath(args.path);
    await sandbox.writeFiles([
      { path: file.absolute, content: Buffer.from(content) },
    ]);
    return `Wrote ${file.relative}`;
  }
  if (name === "read_file") {
    if (typeof args.path !== "string")
      throw new Error("read_file needs a path.");
    const file = workspaceFilePath(args.path);
    const result = await sandbox.runCommand({
      cmd: "cat",
      args: [file.absolute],
    });
    if (result.exitCode !== 0)
      return `${file.relative} is not in the workspace.`;
    return (await result.stdout()).slice(0, 8000);
  }
  throw new Error(`Unknown tool ${name}.`);
}

export async function editWorkspace(
  sandbox: WorkspaceFiles,
  prompt: string,
  options: { followUp?: boolean; client?: ChatClient } = {},
) {
  const client = options.client ?? openRouterClient();
  const messages: unknown[] = [
    {
      role: "system",
      content: [
        "You edit a Next.js App Router app in /workspace.",
        "The starter already has app/page.tsx, app/layout.tsx, app/globals.css, package.json, and next.config.ts.",
        "Match the request by writing app/page.tsx and, only when needed, new files under app/ or components/.",
        "Use TypeScript, Tailwind classes, and lucide-react. Do not add dependencies, remote fonts, or network calls.",
        "Do not modify package.json, next.config.ts, postcss.config.mjs, or AGENTS.md.",
        options.followUp
          ? "This changes an existing app. Read app/page.tsx before writing."
          : "Prefer a single app/page.tsx when the request fits on one page.",
        "Call write_file for every change. Then reply with a short summary and no tool calls.",
      ].join(" "),
    },
    { role: "user", content: prompt.slice(0, 12_000) },
  ];
  let writes = 0;
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const completion = await client.chat.completions.create({
      model: openRouterModel(),
      messages,
      tools,
      temperature: 0.2,
      max_tokens: 6000,
    });
    const message = completion.choices?.[0]?.message;
    if (!message) throw new Error("OpenRouter returned an empty response.");
    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      if (writes === 0) throw new Error("OpenRouter did not change the app.");
      const text = (message.content || "").trim();
      return text || "Updated the app.";
    }
    messages.push({
      role: "assistant",
      content: message.content ?? null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.function.name,
          arguments:
            typeof call.function.arguments === "string"
              ? call.function.arguments
              : JSON.stringify(call.function.arguments ?? {}),
        },
      })),
    });
    for (const call of calls) {
      let result = "";
      try {
        result = await applyTool(
          sandbox,
          call.function.name,
          argumentsOf(call.function.arguments),
        );
        if (result.startsWith("Wrote ")) writes += 1;
      } catch (error) {
        result = error instanceof Error ? error.message : "Tool failed";
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result.slice(0, 8000),
      });
    }
  }
  if (writes === 0) throw new Error("OpenRouter did not change the app.");
  return "Updated the app.";
}
