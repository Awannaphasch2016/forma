"use client";

type ClerkSession = {
  getToken: () => Promise<string | null>;
};

type ClerkGlobal = {
  load: () => Promise<void>;
  addListener: (callback: () => void) => void;
  session?: ClerkSession | null;
  redirectToSignIn: (options: { redirectUrl: string }) => Promise<unknown>;
  signOut: (options: { redirectUrl: string }) => Promise<unknown>;
};

declare global {
  interface Window {
    Clerk?: ClerkGlobal;
  }
}

let clerkStart: Promise<boolean> | null = null;

function loadClerk(publishableKey: string) {
  if (window.Clerk) return Promise.resolve();
  const encoded = publishableKey.slice("pk_test_".length);
  const frontendApi = atob(encoded).replace(/\$$/, "");
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.async = true;
    script.crossOrigin = "anonymous";
    script.dataset.clerkPublishableKey = publishableKey;
    script.src = `https://${frontendApi}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Clerk did not load"));
    document.head.appendChild(script);
  });
}

export function clerkReady() {
  clerkStart ??= (async () => {
    const configResponse = await fetch("/api/clerk");
    if (!configResponse.ok) return false;
    const config = (await configResponse.json()) as { publishableKey?: string };
    const publishableKey = config.publishableKey ?? "";
    if (!publishableKey.startsWith("pk_test_")) return false;
    await loadClerk(publishableKey);
    if (!window.Clerk) return false;
    await window.Clerk.load();
    return true;
  })();
  return clerkStart;
}

export async function clerkBearer() {
  await clerkReady().catch(() => false);
  const token = await window.Clerk?.session?.getToken();
  return token ?? null;
}

export async function clerkSignOut() {
  await window.Clerk?.signOut({ redirectUrl: window.location.href });
  window.location.reload();
}

export function clerkSignIn() {
  return window.Clerk?.redirectToSignIn({ redirectUrl: window.location.href });
}
