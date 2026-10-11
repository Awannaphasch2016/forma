import { randomUUID } from "node:crypto";
import { query, transaction } from "./db";
import { HttpError } from "./http";
import { finishJob } from "./projects";
import { classifyStop } from "./request-marker";
import type { GateRoleId } from "./sign-in";
import type { Job } from "./types";

export type VisibleAsk = {
  id: string;
  body: string;
  uncertain: boolean;
};

type QuestionRow = {
  id: string;
  target_role: string | null;
  uncertain: boolean;
  body: string;
  status: string;
  job_id: string;
};

export function canSeeAsk(
  roleId: string,
  targetRole: string | null,
  uncertain: boolean,
) {
  if (uncertain) return roleId === "project-manager";
  return roleId === targetRole;
}

export function followUpPrompt(question: string, answer: string) {
  return [
    "The human answered the question below. Continue the same task.",
    "Do not repeat the question in your reply.",
    "",
    "Question:",
    question,
    "",
    "Answer:",
    answer,
  ].join("\n");
}

export async function assistantTranscript(jobId: string) {
  const rows = await query<{ content: string }>(
    "SELECT content FROM messages WHERE job_id=$1 AND role='assistant' ORDER BY id",
    [jobId],
  );
  return rows.map((row) => row.content).join("\n\n");
}

async function hideAssistant(jobId: string) {
  await query("DELETE FROM messages WHERE job_id=$1 AND role='assistant'", [
    jobId,
  ]);
}

export async function holdForRequest(job: Job) {
  const [existing] = await query<QuestionRow>(
    "SELECT id,target_role,uncertain,body,status,job_id FROM hitl_questions WHERE job_id=$1",
    [job.id],
  );
  if (existing) {
    await hideAssistant(job.id);
    await finishJob(job, "waiting_for_human");
    return true;
  }
  const decision = classifyStop(await assistantTranscript(job.id));
  if (decision.kind === "completed") return false;
  const id = randomUUID();
  await query(
    "INSERT INTO hitl_questions(id,organization_id,project_id,job_id,target_role,uncertain,body) SELECT $1,owner_id,$2,$3,$4,$5,$6 FROM projects WHERE id=$2",
    [
      id,
      job.project_id,
      job.id,
      decision.kind === "question" ? decision.role : null,
      decision.kind === "uncertain",
      decision.body,
    ],
  );
  await hideAssistant(job.id);
  await finishJob(job, "waiting_for_human");
  return true;
}

export async function visibleAsk(projectId: string, roleId: GateRoleId) {
  const [row] = await query<QuestionRow>(
    "SELECT id,target_role,uncertain,body,status,job_id FROM hitl_questions WHERE project_id=$1 AND status='open'",
    [projectId],
  );
  if (!row || !canSeeAsk(roleId, row.target_role, row.uncertain)) return null;
  return {
    id: row.id,
    body: row.body,
    uncertain: row.uncertain,
  } satisfies VisibleAsk;
}

export async function answerHitl({
  projectId,
  organizationId,
  roleId,
  userId,
  requestId,
  answer,
}: {
  projectId: string;
  organizationId: string;
  roleId: GateRoleId;
  userId: string;
  requestId: string;
  answer: string;
}) {
  return transaction(async (q) => {
    const [project] = await q<{
      id: string;
      session_id: string | null;
      active_job_id: string | null;
    }>(
      "SELECT id,session_id,active_job_id FROM projects WHERE id=$1 AND owner_id=$2 FOR UPDATE",
      [projectId, organizationId],
    );
    if (!project) throw new HttpError(404, "Project not found.");
    const [same] = await q<{ follow_up_job_id: string }>(
      "SELECT follow_up_job_id FROM hitl_answers WHERE request_id=$1",
      [requestId],
    );
    if (same) {
      const [job] = await q<Job>("SELECT * FROM jobs WHERE id=$1", [
        same.follow_up_job_id,
      ]);
      return job;
    }
    const [question] = await q<QuestionRow>(
      "SELECT id,target_role,uncertain,body,status,job_id FROM hitl_questions WHERE project_id=$1 AND status='open'",
      [projectId],
    );
    if (!question) throw new HttpError(409, "There is no open question.");
    if (project.active_job_id)
      throw new HttpError(
        409,
        "An edit or preview operation is already running.",
      );
    if (!canSeeAsk(roleId, question.target_role, question.uncertain))
      throw new HttpError(403, "You cannot answer this question.");
    const jobId = randomUUID();
    const prompt = followUpPrompt(question.body, answer);
    const [job] = await q<Job>(
      "INSERT INTO jobs(id,project_id,kind,prompt) VALUES($1,$2,'edit',$3) RETURNING *",
      [jobId, projectId, prompt],
    );
    await q(
      "UPDATE projects SET active_job_id=$2,status='queued',updated_at=now(),last_seen_at=now() WHERE id=$1",
      [projectId, jobId],
    );
    await q("UPDATE hitl_questions SET status='answered' WHERE id=$1", [
      question.id,
    ]);
    await q(
      "INSERT INTO hitl_answers(id,question_id,user_id,body,request_id,follow_up_job_id) VALUES($1,$2,$3,$4,$5,$6)",
      [randomUUID(), question.id, userId, answer, requestId, jobId],
    );
    return job;
  });
}
