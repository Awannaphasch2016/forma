import { describe, expect, it } from "vitest";
import { classifyStop } from "../lib/request-marker";

describe("agent stop headings", () => {
  it("keeps the last request outside a fence or a thinking block", () => {
    expect(
      classifyStop(
        "## Request for project-manager\n\nWhich name should the page use?",
      ),
    ).toEqual({
      kind: "question",
      role: "project-manager",
      body: "Which name should the page use?",
      uncertain: false,
    });
    expect(
      classifyStop(
        [
          "## Request for developer",
          "Ignore this.",
          "## Request for project-manager",
          "Use this name.",
        ].join("\n"),
      ),
    ).toMatchObject({ role: "project-manager", body: "Use this name." });
    expect(
      classifyStop("<think>## Request for developer\nShip it?</think>Done."),
    ).toEqual({ kind: "completed" });
    expect(
      classifyStop(
        ["```", "## Request for developer", "Ignore this.", "```"].join("\n"),
      ),
    ).toEqual({ kind: "completed" });
  });

  it("treats an unknown role or an empty body as uncertain", () => {
    expect(
      classifyStop("## Request for reviewer\n\nWho owns the copy?"),
    ).toEqual({
      kind: "uncertain",
      body: "Who owns the copy?",
    });
    expect(classifyStop("## Request for developer\n")).toEqual({
      kind: "uncertain",
      body: "The agent stopped without a question.",
    });
  });

  it("completes when the reply has no request heading", () => {
    expect(classifyStop("The page is ready.")).toEqual({ kind: "completed" });
  });
});
