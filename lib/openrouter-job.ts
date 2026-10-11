import { query } from "./db";
import { addMessage, finishJob, getProject } from "./projects";
import { checkBuild, prepareSandbox, startPreview } from "./sandbox";
import type { Job } from "./types";
import { editWorkspace, openRouterError } from "./openrouter";

type Progress = (text: string, key: string) => Promise<unknown>;

export async function executeOpenRouterJob(job: Job, progress: Progress) {
  const project = await getProject(job.project_id);
  await progress(
    project.session_id
      ? "Reconnecting your workspace…"
      : "Preparing your Next.js workspace…",
    "prepare",
  );
  const sandbox = await prepareSandbox(project, { executor: false });
  if (!project.session_id) {
    await query("UPDATE projects SET session_id=$2 WHERE id=$1", [
      project.id,
      `openrouter:${project.id}`,
    ]);
  }
  if (job.kind === "resume") {
    const url = await startPreview(sandbox);
    await query(
      "UPDATE projects SET preview_url=$2,status='ready' WHERE id=$1",
      [project.id, url],
    );
    await progress(
      "Preview reconnected. Pick up where you left off.",
      "resumed",
    );
    await finishJob(job, "ready");
    return;
  }
  await query("UPDATE projects SET status='editing' WHERE id=$1", [project.id]);
  await progress("Writing the app with OpenRouter…", "writing");
  let summary = "";
  try {
    summary = await editWorkspace(sandbox, job.prompt || "", {
      followUp: Boolean(project.preview_url),
    });
  } catch (error) {
    const message = openRouterError(error).slice(0, 4000);
    await addMessage(
      project.id,
      job.id,
      "error",
      message,
      `${job.id}:openrouter-error`,
    );
    await finishJob(job, "error", message.slice(0, 500));
    return;
  }
  await addMessage(
    project.id,
    job.id,
    "assistant",
    summary || "Updated the app.",
    `${job.id}:openrouter`,
  );
  await query("UPDATE jobs SET phase='checking' WHERE id=$1", [job.id]);
  await progress("Checking the build and refreshing your preview…", "checking");
  try {
    await checkBuild(sandbox);
    const preview = await startPreview(sandbox);
    await query("UPDATE projects SET preview_url=$2 WHERE id=$1", [
      project.id,
      preview,
    ]);
    await progress("Build passed. Your preview is ready.", "ready");
    await finishJob(job, "ready");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Build failed. Ask for a fix.";
    await addMessage(project.id, job.id, "error", message.slice(0, 4000));
    await finishJob(job, "error", "Build check failed");
  }
}
