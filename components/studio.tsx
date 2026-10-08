"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  Code2,
  ExternalLink,
  Layers3,
  Loader2,
  LockKeyhole,
  LogOut,
  Monitor,
  Pause,
  Plus,
  RotateCw,
  Smartphone,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import type { Message, Project } from "@/lib/types";
import Markdown from "react-markdown";
import { clerkBearer, clerkReady, clerkSignIn, clerkSignOut } from "./clerk-browser";

type SessionView = {
  signedIn: boolean;
  organization?: string | null;
  role?: string | null;
};

async function api(path: string, body?: unknown, method?: string) {
  const token = await clerkBearer();
  const headers = new Headers();
  if (body) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(path, {
    method: method || (body ? "POST" : "GET"),
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}
const examples = [
  {
    title: "A home for your ideas",
    description:
      "A minimal notes app with folders, search and a warm paper-like design.",
    icon: Layers3,
  },
  {
    title: "Your next big launch",
    description:
      "An editorial landing page for a ceramics studio, with a collection grid.",
    icon: Sparkles,
  },
  {
    title: "A little more clarity",
    description:
      "A personal finance dashboard with spending categories and monthly charts.",
    icon: Code2,
  },
];
const stateLabels: Record<string, string> = {
  new: "New project",
  queued: "Queued",
  starting: "Opening workspace",
  editing: "Building",
  ready: "Preview ready",
  error: "Needs attention",
  stopped: "Workspace paused",
  stopping: "Saving workspace",
};

export function Studio() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [clerkFailed, setClerkFailed] = useState(false);
  const [clerkReadyState, setClerkReadyState] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [provider, setProvider] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [history, setHistory] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedOpen, setSavedOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const [showActivity, setShowActivity] = useState(false);
  const [connected, setConnected] = useState(true);
  const [mobileTab, setMobileTab] = useState("chat");
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const active = busy || !!project?.active_job_id;
  const open = Boolean(session?.signedIn && session.role);
  const accountLabel = [session?.organization, session?.role]
    .filter(Boolean)
    .join(" · ");
  const refreshProjects = useCallback(async () => {
    const data = await api("/api/projects");
    setProjects(data.projects);
  }, []);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const [authResponse, status] = await Promise.all([
        api("/api/auth"),
        api("/api/status"),
      ]);
      if (cancelled) return;
      setSession(authResponse as SessionView);
      setConfigured(status.configured);
      setProvider(typeof status.provider === "string" ? status.provider : "");
    };
    void clerkReady()
      .then(async (ready) => {
        if (cancelled) return;
        if (!ready || !window.Clerk) {
          setClerkFailed(true);
          setSession({ signedIn: false });
          return;
        }
        setClerkReadyState(true);
        window.Clerk.addListener(() => {
          void refresh().catch(() => setSession({ signedIn: false }));
        });
        await refresh();
      })
      .catch(() => {
        if (!cancelled) {
          setClerkFailed(true);
          setSession({ signedIn: false });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const openProject = useCallback(async (id: string) => {
    setError("");
    setSavedOpen(false);
    setBusy(true);
    try {
      const data = await api(`/api/projects/${id}`);
      setProject(data.project);
      setHistory(data.messages);
      window.history.replaceState(null, "", `?project=${id}`);
      if (!data.project.active_job_id)
        await api(`/api/projects/${id}/resume`, {
          requestId: crypto.randomUUID(),
        });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api("/api/projects")
      .then((data) => {
        if (cancelled) return;
        setProjects(data.projects);
        const id = new URLSearchParams(window.location.search).get("project");
        if (id) void openProject(id);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [open, refreshProjects, openProject]);
  useEffect(() => {
    if (!project?.id || !open) return;
    const controller = new AbortController();
    let stopped = false;
    const read = async () => {
      while (!stopped && !controller.signal.aborted) {
        try {
          const token = await clerkBearer();
          const response = await fetch(`/api/projects/${project.id}/events`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            signal: controller.signal,
          });
          if (!response.ok || !response.body) {
            setConnected(false);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            continue;
          }
          setConnected(true);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (!stopped) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const chunks = buffer.split("\n\n");
            buffer = chunks.pop() ?? "";
            for (const chunk of chunks) {
              const line = chunk
                .split("\n")
                .find((item) => item.startsWith("data: "));
              if (!line) continue;
              const data = JSON.parse(line.slice("data: ".length));
              setProject(data.project);
              setHistory(data.messages);
            }
          }
        } catch {
          if (!controller.signal.aborted) setConnected(false);
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
    };
    void read();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [project?.id, open]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history.length]);
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!prompt.trim() || active || !configured) return;
    setBusy(true);
    setError("");
    try {
      if (!project) {
        const data = await api("/api/projects", {
          prompt,
          id: crypto.randomUUID(),
          requestId: crypto.randomUUID(),
        });
        setProject(data.project);
        setHistory([]);
        window.history.replaceState(null, "", `?project=${data.project.id}`);
      } else
        await api(`/api/projects/${project.id}/messages`, {
          prompt,
          requestId: crypto.randomUUID(),
        });
      setPrompt("");
      await refreshProjects();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function operation(kind: "stop" | "resume") {
    if (!project || active) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/projects/${project.id}/${kind}`, {
        requestId: crypto.randomUUID(),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const newProject = () => {
    setProject(null);
    setHistory([]);
    setPrompt("");
    setSavedOpen(false);
    setError("");
    window.history.replaceState(null, "", "/");
  };
  const renderedMessages = history.reduce<Message[]>((all, message) => {
    const last = all.at(-1);
    if (message.role === "assistant" && last?.role === "assistant")
      last.content += message.content;
    else all.push({ ...message });
    return all;
  }, []);
  return (
    <div className="studio">
      <header className="topbar">
        <button className="brand" onClick={newProject} aria-label="Forma home">
          <span className="brand-symbol">f</span>
          <span>
            forma<span className="brand-period">.</span>
          </span>
        </button>
        <span className="header-divider" />
        <span className="workspace-label">
          {accountLabel || "Personal workspace"}
        </span>
        <span className="demo-badge">LAB</span>
        <div className="header-actions">
          <span className="saved-note">
            <span className="small-dot" />{" "}
            {project
              ? "Changes saved as you build"
              : "A little idea. A real app."}
          </span>
          <button
            className="icon-button account"
            aria-label="Sign out"
            onClick={() => {
              if (open) void clerkSignOut();
            }}
            title={open ? "Sign out" : "Private workspace"}
          >
            {open ? <LogOut size={15} /> : <LockKeyhole size={15} />}
          </button>
        </div>
      </header>
      <div className="mobile-tabs">
        <button
          onClick={() => setMobileTab("chat")}
          data-active={mobileTab === "chat"}
        >
          Chat
        </button>
        <button
          onClick={() => setMobileTab("preview")}
          data-active={mobileTab === "preview"}
        >
          Preview
        </button>
      </div>
      <main className={`workspace mobile-${mobileTab}`}>
        <section className="chat-panel">
          <div className="panel-heading">
            <button
              className="project-picker"
              onClick={() => {
                setSavedOpen(!savedOpen);
                if (open) refreshProjects().catch((e) => setError(e.message));
              }}
            >
              <span>{project?.name || "New project"}</span>
              <ChevronDown size={14} />
            </button>
            <button
              className="icon-button"
              aria-label="New project"
              onClick={newProject}
            >
              <Plus size={17} />
            </button>
          </div>
          {savedOpen && (
            <div className="saved-projects">
              <div className="saved-title">
                YOUR PROJECTS{" "}
                <button
                  className="icon-button"
                  onClick={() => setSavedOpen(false)}
                  aria-label="Close projects"
                >
                  <X size={14} />
                </button>
              </div>
              {projects.length ? (
                projects.map((p) => (
                  <button key={p.id} onClick={() => openProject(p.id)}>
                    <Layers3 size={16} />
                    <span>
                      {p.name}
                      <small>{stateLabels[p.status] || p.status}</small>
                    </span>
                    <ArrowUpRight size={14} />
                  </button>
                ))
              ) : (
                <p>Your saved projects will appear here.</p>
              )}
            </div>
          )}
          <div className="conversation">
            {!project ? (
              <div className="welcome">
                <div className="eyebrow">
                  <span className="tiny-star">✳</span> THE START OF SOMETHING
                </div>
                <h1>
                  What do you
                  <br />
                  want to <em>make?</em>
                </h1>
                <p>
                  Describe the app you have in mind.
                  <br />
                  We’ll bring the first version to life.
                </p>
                <div className="suggestion-list">
                  {examples.map(({ title, description, icon: Icon }) => (
                    <button
                      key={title}
                      className="suggestion"
                      onClick={() => {
                        setPrompt(description);
                        textareaRef.current?.focus();
                      }}
                    >
                      <Icon size={17} />
                      <span>{title}</span>
                      <ArrowUpRight size={15} />
                    </button>
                  ))}
                </div>
                <div className="welcome-footnote">
                  Start small. Make it yours.
                </div>
              </div>
            ) : (
              <div className="messages">
                <div className="project-start">
                  <span className="tiny-star">✳</span> A new idea, taking shape.
                </div>
                {renderedMessages
                  .filter(
                    (m) =>
                      showActivity ||
                      m.role !== "progress" ||
                      m.id ===
                        history.filter((h) => h.role === "progress").at(-1)?.id,
                  )
                  .map((m) => (
                    <div className={`message ${m.role}`} key={m.id}>
                      {m.role === "user" ? (
                        <span className="message-label">YOU</span>
                      ) : m.role === "assistant" ? (
                        <span className="message-label">
                          <span className="tiny-star">✳</span> FORMA
                        </span>
                      ) : null}
                      {m.role === "progress" ? <Check size={13} /> : null}
                      <div>
                        {m.role === "assistant" ? (
                          <Markdown skipHtml>{m.content}</Markdown>
                        ) : (
                          m.content
                        )}
                      </div>
                    </div>
                  ))}
                {active && (
                  <div className="working">
                    <Loader2 className="spin" size={15} />
                    {stateLabels[project.status] || "Working"}
                    <span className="working-dots">···</span>
                  </div>
                )}
                <div ref={endRef} />
              </div>
            )}
          </div>
          <div className="composer-area">
            {error && (
              <div className="error-banner" role="alert">
                {error}
                <button aria-label="Dismiss error" onClick={() => setError("")}>
                  <X size={14} />
                </button>
              </div>
            )}
            {!configured && (
              <div className="config-banner">
                Setup is in progress. An OpenRouter key or the OpenAI Agents
                credentials are still missing.
              </div>
            )}
            <form className="composer" onSubmit={submit}>
              <textarea
                ref={textareaRef}
                aria-label="Describe your app"
                placeholder={
                  project
                    ? "What should we change next?"
                    : "An app for that idea you keep thinking about…"
                }
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                maxLength={12000}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
              <div className="composer-bottom">
                <span>
                  <span className="agent-dot" />
                  {provider === "openrouter"
                    ? "OpenRouter"
                    : provider === "openai"
                      ? "OpenAI Agent"
                      : "Agent"}
                </span>
                <button
                  className="send-button"
                  disabled={!prompt.trim() || active || !open || !configured}
                  aria-label="Send prompt"
                >
                  {busy ? (
                    <Loader2 size={17} className="spin" />
                  ) : (
                    <ArrowUp size={19} />
                  )}
                </button>
              </div>
            </form>
            <div className="composer-note">
              <LockKeyhole size={11} />
              Private workspace<span>↵ to send</span>
            </div>
          </div>
        </section>
        <section className="preview-panel">
          <div className="preview-toolbar">
            <div className="preview-tab">
              <Monitor size={15} />
              Preview
            </div>
            <div className="viewport-controls">
              <button
                className="icon-button"
                data-active={!mobile}
                onClick={() => setMobile(false)}
                aria-label="Desktop preview"
              >
                <Monitor size={15} />
              </button>
              <button
                className="icon-button"
                data-active={mobile}
                onClick={() => setMobile(true)}
                aria-label="Mobile preview"
              >
                <Smartphone size={15} />
              </button>
            </div>
            <div className="preview-actions">
              <button
                className="icon-button"
                aria-label="Reload preview"
                onClick={() => setPreviewKey((k) => k + 1)}
                disabled={!project?.preview_url}
              >
                <RotateCw size={15} />
              </button>
              {project?.preview_url ? (
                <a
                  className="icon-button"
                  aria-label="Open preview in new tab"
                  href={project.preview_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink size={15} />
                </a>
              ) : (
                <button
                  className="icon-button"
                  disabled
                  aria-label="Open preview"
                >
                  <ExternalLink size={15} />
                </button>
              )}
            </div>
          </div>
          <div className={`preview-canvas ${mobile ? "phone-mode" : ""}`}>
            {project?.preview_url &&
            !["stopped", "starting", "stopping"].includes(project.status) ? (
              <iframe
                key={`${project.id}-${previewKey}`}
                src={project.preview_url}
                title="Generated app preview"
                sandbox="allow-scripts allow-same-origin allow-forms"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="empty-preview">
                <div className="canvas-art" aria-hidden="true">
                  <div className="art-shadow" />
                  <div className="art-window">
                    <div className="art-chrome">
                      <i />
                      <i />
                      <i />
                      <span />
                    </div>
                    <div className="art-content">
                      <div className="art-left">
                        <div className="art-tag" />
                        <div className="art-line wide" />
                        <div className="art-line" />
                        <div className="art-copy" />
                        <div className="art-copy short" />
                        <div className="art-button" />
                      </div>
                      <div className="art-right">
                        <div className="art-orbit" />
                        <div className="art-sphere" />
                        <div className="art-caption" />
                      </div>
                    </div>
                  </div>
                  <div className="art-cursor">
                    <span>↖</span>
                    <b>Your idea</b>
                  </div>
                  <div className="art-spark">✳</div>
                </div>
                <div className="empty-preview-copy">
                  <span className="eyebrow">
                    {project
                      ? "RIGHT WHERE YOU LEFT IT"
                      : "ROOM FOR POSSIBILITY"}
                  </span>
                  <h2>
                    {project?.status === "stopped"
                      ? "Your idea is safe here."
                      : project
                        ? "Making room for your idea."
                        : "Your idea, in view."}
                  </h2>
                  <p>
                    {project?.status === "stopped"
                      ? "Resume your workspace to bring the preview back."
                      : project
                        ? "Your live preview will appear as soon as the workspace is ready."
                        : "A working preview will appear here.\nEvery conversation brings it a little closer."}
                  </p>
                  {project?.status === "stopped" && (
                    <button
                      className="primary-button"
                      onClick={() => operation("resume")}
                      disabled={active}
                    >
                      Resume workspace <ArrowUpRight size={15} />
                    </button>
                  )}
                </div>
                <div className="preview-stack">
                  <span>N</span>Next.js
                  <i />
                  Tailwind CSS
                  <i />
                  Built with you
                </div>
              </div>
            )}
          </div>
          <footer className="preview-status">
            <span>
              <span className={`small-dot ${active ? "amber" : ""}`} />
              {project
                ? stateLabels[project.status] || project.status
                : "Ready when you are"}
            </span>
            <div>
              {!connected && (
                <span className="reconnecting">Reconnecting…</span>
              )}
              {project && (
                <>
                  <button onClick={() => setShowActivity(!showActivity)}>
                    <Terminal size={12} />
                    Activity
                  </button>
                  <button
                    onClick={() =>
                      operation(
                        project.status === "stopped" ? "resume" : "stop",
                      )
                    }
                    disabled={active}
                  >
                    <Pause size={12} />
                    {project.status === "stopped" ? "Resume" : "Save & pause"}
                  </button>
                </>
              )}
              <span className="sandbox-label">Vercel Sandbox</span>
            </div>
          </footer>
        </section>
      </main>
      {session && !open && (
        <div className="login-overlay">
          <div className="login-card">
            <span className="brand-symbol">f</span>
            <span className="eyebrow">YOUR PRIVATE WORKSPACE</span>
            <h2>
              A place to make
              <br />
              something new.
            </h2>
            <p>
              {session.signedIn
                ? "This account is not a member of Wewebplus."
                : "Sign in with your Wewebplus account to get started."}
            </p>
            {error && (
              <p role="alert" className="login-error">
                {error}
              </p>
            )}
            {session.signedIn ? (
              <button className="primary-button" onClick={() => void clerkSignOut()}>
                Sign out
              </button>
            ) : (
              <button
                className="primary-button"
                data-testid="forma-sign-in"
                disabled={!clerkReadyState || clerkFailed}
                onClick={() => void clerkSignIn()}
              >
                {clerkFailed ? "Sign in did not load" : "Sign in"}
                <ArrowUpRight size={17} />
              </button>
            )}
            <small>
              {provider === "openai"
                ? "OpenAI Agents × Vercel Sandbox"
                : "OpenRouter × Vercel Sandbox"}
            </small>
          </div>
        </div>
      )}
      {session === null && (
        <div className="loading-overlay">
          <Loader2 className="spin" size={23} />
          <span>Opening your workspace…</span>
        </div>
      )}
    </div>
  );
}
