import type { GateRoleId } from "./sign-in";

export type StopDecision =
  | { kind: "completed" }
  | {
      kind: "question";
      role: GateRoleId;
      body: string;
      uncertain: false;
    }
  | { kind: "uncertain"; body: string };

const HEADING = /^\s*#{1,4}\s*(.+?)\s*$/;
const FENCE = /^\s*```/;
const ROLES = new Set<GateRoleId>(["project-manager", "developer"]);
const UNCERTAIN_BODY = "The agent stopped without a question.";

function headingText(line: string): string | null {
  const match = HEADING.exec(line);
  if (!match) return null;
  return match[1].replace(/\*/g, "").replace(/:\s*$/, "").trim().toLowerCase();
}

function isRole(role: string): role is GateRoleId {
  return ROLES.has(role as GateRoleId);
}

/**
 * The last `## Request for <role>` outside a code fence and a thinking block.
 * A known role with a body is that role's question. Any other request heading
 * stays uncertain. No request heading means the turn completed.
 */
export function classifyStop(content: string): StopDecision {
  const withoutThinking = content.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const lines = withoutThinking.split(/\r?\n/);
  let fenced = false;
  let last: { role: string; start: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const text = headingText(line);
    if (!text) continue;
    const role = /^request for\s+(.+)$/.exec(text)?.[1];
    if (!role) continue;
    last = { role, start: index };
  }
  if (!last) return { kind: "completed" };

  fenced = false;
  const body: string[] = [];
  for (const line of lines.slice(last.start + 1)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      body.push(line);
      continue;
    }
    if (!fenced && headingText(line) != null) break;
    body.push(line);
  }
  const text = body.join("\n").trim();
  if (isRole(last.role) && text.length > 0) {
    return { kind: "question", role: last.role, body: text, uncertain: false };
  }
  return { kind: "uncertain", body: text || UNCERTAIN_BODY };
}
