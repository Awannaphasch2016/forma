import { afterEach, expect, it, vi } from "vitest";
import { Sandbox } from "@vercel/sandbox";
import { missingConfig, providerMode } from "../lib/config";
import {
  applyTool,
  editWorkspace,
  openRouterModel,
  workspaceFilePath,
  type WorkspaceFiles,
} from "../lib/openrouter";
import { prepareSandbox } from "../lib/sandbox";
import type { Project } from "../lib/types";

vi.mock("@vercel/sandbox", () => ({
  Sandbox: { get: vi.fn(), getOrCreate: vi.fn() },
}));

const NAMES = [
  "DATABASE_URL",
  "APP_PASSWORD",
  "AUTH_SECRET",
  "CRON_SECRET",
  "OPENAI_API_KEY",
  "OPENAI_EXECUTOR_API_KEY",
  "OPENAI_AGENT_ID",
  "OPENAI_WEBHOOK_SECRET",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
];

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

function withEnv(values: Record<string, string> = {}) {
  for (const name of NAMES) vi.stubEnv(name, "");
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
}

it("treats an OpenRouter key as configured without OpenAI credentials", () => {
  withEnv({
    DATABASE_URL: "postgres://local/db",
    APP_PASSWORD: "pw",
    AUTH_SECRET: "auth",
    CRON_SECRET: "cron",
    OPENROUTER_API_KEY: "sk-or-example",
  });
  expect(providerMode()).toBe("openrouter");
  expect(missingConfig()).toEqual([]);
  expect(openRouterModel()).toBe("openai/gpt-4.1-mini");
  vi.stubEnv("OPENROUTER_MODEL", "google/gemini-2.5-flash");
  expect(openRouterModel()).toBe("google/gemini-2.5-flash");
});

it("keeps the Agents credentials when OpenRouter is absent", () => {
  withEnv({
    DATABASE_URL: "postgres://local/db",
    APP_PASSWORD: "pw",
    AUTH_SECRET: "auth",
    CRON_SECRET: "cron",
    OPENAI_API_KEY: "sk-example",
    OPENAI_EXECUTOR_API_KEY: "executor",
    OPENAI_AGENT_ID: "agent",
    OPENAI_WEBHOOK_SECRET: "whsec",
  });
  expect(providerMode()).toBe("openai");
  expect(missingConfig()).toEqual([]);
});

it("still reports the Agents names when neither provider is set", () => {
  withEnv();
  expect(providerMode()).toBe("unconfigured");
  expect(missingConfig()).toEqual([
    "DATABASE_URL",
    "APP_PASSWORD",
    "AUTH_SECRET",
    "CRON_SECRET",
    "OPENAI_API_KEY",
    "OPENAI_EXECUTOR_API_KEY",
    "OPENAI_AGENT_ID",
    "OPENAI_WEBHOOK_SECRET",
  ]);
});

it("rejects paths outside the generated app", () => {
  expect(workspaceFilePath("app/page.tsx").absolute).toBe(
    "/workspace/app/page.tsx",
  );
  expect(workspaceFilePath("/workspace/components/Note.tsx").relative).toBe(
    "components/Note.tsx",
  );
  expect(() => workspaceFilePath("../package.json")).toThrow(/outside/);
  expect(() => workspaceFilePath("app/../../package.json")).toThrow(/outside/);
  expect(() => workspaceFilePath("package.json")).toThrow(/managed/);
  expect(() => workspaceFilePath(".env")).toThrow(/outside/);
});

it("writes only inside the workspace", async () => {
  const written: string[] = [];
  const sandbox: WorkspaceFiles = {
    async writeFiles(files) {
      written.push(...files.map((file) => file.path));
    },
    async runCommand() {
      return { exitCode: 1, stdout: async () => "" };
    },
  };
  await expect(
    applyTool(sandbox, "write_file", {
      path: "app/page.tsx",
      content: "export default function Page(){return null}",
    }),
  ).resolves.toBe("Wrote app/page.tsx");
  expect(written).toEqual(["/workspace/app/page.tsx"]);
  await expect(
    applyTool(sandbox, "write_file", {
      path: "package.json",
      content: "{}",
    }),
  ).rejects.toThrow(/managed/);
});

it("applies a tool call and returns the summary", async () => {
  const files = new Map<string, string>();
  const sandbox: WorkspaceFiles = {
    async writeFiles(items) {
      for (const item of items) files.set(item.path, item.content.toString());
    },
    async runCommand({ args }) {
      const text = files.get(args[0]);
      if (text === undefined) return { exitCode: 1, stdout: async () => "" };
      return { exitCode: 0, stdout: async () => text };
    },
  };
  let calls = 0;
  const summary = await editWorkspace(sandbox, "A notes app", {
    client: {
      chat: {
        completions: {
          async create({ messages }) {
            calls += 1;
            const last = messages[messages.length - 1] as { role?: string };
            if (last.role === "user") {
              return {
                choices: [
                  {
                    message: {
                      content: null,
                      tool_calls: [
                        {
                          id: "call_1",
                          function: {
                            name: "write_file",
                            arguments: JSON.stringify({
                              path: "app/page.tsx",
                              content:
                                "export default function Page(){return <main>Notes</main>}",
                            }),
                          },
                        },
                      ],
                    },
                  },
                ],
              };
            }
            return {
              choices: [
                {
                  message: {
                    content: "A notes page is ready.",
                    tool_calls: [],
                  },
                },
              ],
            };
          },
        },
      },
    },
  });
  expect(calls).toBe(2);
  expect(summary).toBe("A notes page is ready.");
  expect(files.get("/workspace/app/page.tsx")).toContain("Notes");
});

it("prepares an OpenRouter workspace without the Codex executor", async () => {
  const runCommand = vi.fn(async (command: { args?: string[] }) => ({
    exitCode: command.args ? 0 : 1,
  }));
  vi.mocked(Sandbox.getOrCreate).mockResolvedValue({
    runCommand,
    writeFiles: vi.fn(),
    expiresAt: new Date(Date.now() + 20 * 60_000),
    extendTimeout: vi.fn(),
  } as never);
  await prepareSandbox(
    { session_id: null, sandbox_name: "new-app" } as unknown as Project,
    { executor: false },
  );
  const created = vi.mocked(Sandbox.getOrCreate).mock.calls[0]?.[0] as
    | { networkPolicy?: { allow?: string[] } }
    | undefined;
  expect(created?.networkPolicy?.allow).toEqual(["registry.npmjs.org"]);
  const scripts = runCommand.mock.calls.map((call) =>
    String(call[0]?.args?.join(" ")),
  );
  expect(scripts.some((script) => script.includes("codex"))).toBe(false);
});
