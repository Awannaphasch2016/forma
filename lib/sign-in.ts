// Clerk owns the session. wewebplus.memberships owns the gate role.
// The workspace password is not a session.

export const PROJECT_MANAGER_ROLE = "project-manager";
export const DEVELOPER_ROLE = "developer";

export type FormaSession = {
  signedIn: boolean;
  organization: string | null;
  role: string | null;
  userId: string | null;
};

export type MembershipRow = { org_id?: unknown; role_id?: unknown };

export function clerkKeyKind(value: unknown) {
  const key = String(value ?? "").trim();
  if (key.startsWith("pk_test_") || key.startsWith("sk_test_")) return "test";
  if (key.startsWith("pk_live_") || key.startsWith("sk_live_")) return "live";
  if (!key) return "absent";
  return "other";
}

export function clerkPublishable(value: unknown) {
  const key = String(value ?? "").trim();
  if (!key.startsWith("pk_test_")) {
    return { status: 404, body: { error: "Sign in is not available." } };
  }
  return { status: 200, body: { publishableKey: key } };
}

export function clerkFrontendApi(publishableKey: string) {
  const encoded = publishableKey.slice("pk_test_".length);
  return Buffer.from(encoded, "base64").toString("utf8").replace(/\$$/, "");
}

export function sessionToken(
  authorization: string | null,
  cookie: string | null,
) {
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  if (bearer) return bearer;
  const match = /(?:^|;\s*)__session=([^;]+)/.exec(cookie ?? "");
  return match ? decodeURIComponent(match[1]) : "";
}

function gateRole(roleId: unknown) {
  if (roleId === PROJECT_MANAGER_ROLE) return "Project Manager";
  if (roleId === DEVELOPER_ROLE) return "Developer";
  return "";
}

export function formaSession({
  userId = "",
  memberships = [],
  activeOrgIds = null,
  orgNames = {},
}: {
  userId?: string;
  memberships?: MembershipRow[];
  activeOrgIds?: Iterable<string> | null;
  orgNames?: Record<string, string | null>;
} = {}): FormaSession {
  if (!String(userId ?? "").trim()) {
    return { signedIn: false, organization: null, role: null, userId: null };
  }
  const active = activeOrgIds ? new Set([...activeOrgIds].map(String)) : null;
  const usable = memberships.filter((row) => {
    if (!gateRole(row.role_id)) return false;
    if (active && !active.has(String(row.org_id))) return false;
    return true;
  });
  if (usable.length !== 1) {
    return {
      signedIn: true,
      organization: null,
      role: null,
      userId: String(userId),
    };
  }
  const row = usable[0];
  const orgId = String(row.org_id);
  return {
    signedIn: true,
    organization: orgNames[orgId] ?? null,
    role: gateRole(row.role_id),
    userId: String(userId),
  };
}

export function formaOwnerId(session: FormaSession | null | undefined) {
  if (!session?.signedIn || !session.role || !session.userId) return null;
  return session.userId;
}

function decodePart(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

export async function verifyClerkJwt(
  token: string,
  jwks: { keys: (JsonWebKey & { kid?: string })[] },
) {
  const parts = token.split(".");
  const [headerPart, payloadPart, signaturePart] = parts;
  if (parts.length !== 3 || !headerPart || !payloadPart || !signaturePart) {
    throw new Error("Sign in to continue.");
  }
  const header = JSON.parse(decodePart(headerPart)) as { kid?: string };
  const jwk = jwks.keys.find((key) => key.kid === header.kid);
  if (!jwk) throw new Error("Sign in to continue.");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signature = Buffer.from(signaturePart, "base64url");
  const signed = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!signed) throw new Error("Sign in to continue.");
  const payload = JSON.parse(decodePart(payloadPart)) as {
    sub?: string;
    exp?: number;
  };
  if (typeof payload.exp === "number" && payload.exp * 1000 <= Date.now()) {
    throw new Error("Sign in to continue.");
  }
  if (!payload.sub) throw new Error("Sign in to continue.");
  return { userId: payload.sub };
}

const signedOut: FormaSession = {
  signedIn: false,
  organization: null,
  role: null,
  userId: null,
};

export async function formaAccount({
  authorization,
  cookie,
  env,
  fetchImpl = fetch,
  query,
}: {
  authorization: string | null;
  cookie: string | null;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  query?: (
    sql: string,
    params: unknown[],
  ) => Promise<Record<string, unknown>[]>;
}): Promise<FormaSession> {
  const token = sessionToken(authorization, cookie);
  const publishable = String(env.CLERK_PUBLISHABLE_KEY ?? "").trim();
  const secret = String(env.CLERK_SECRET_KEY ?? "").trim();
  if (
    !token ||
    clerkKeyKind(publishable) !== "test" ||
    clerkKeyKind(secret) !== "test"
  ) {
    return signedOut;
  }
  try {
    const frontendApi = clerkFrontendApi(publishable);
    const jwksResponse = await fetchImpl(
      `https://${frontendApi}/.well-known/jwks.json`,
    );
    if (!jwksResponse.ok) return signedOut;
    const jwks = (await jwksResponse.json()) as {
      keys: (JsonWebKey & { kid?: string })[];
    };
    const user = await verifyClerkJwt(token, jwks);
    const databaseUrl = String(env.WEWEBPLUS_DATABASE_URL ?? "").trim();
    if (!databaseUrl || !query) {
      return {
        signedIn: true,
        organization: null,
        role: null,
        userId: user.userId,
      };
    }
    const membershipResponse = await fetchImpl(
      `https://api.clerk.com/v1/users/${encodeURIComponent(user.userId)}/organization_memberships?limit=100`,
      { headers: { Authorization: `Bearer ${secret}` } },
    );
    if (!membershipResponse.ok) return signedOut;
    const membershipPayload = (await membershipResponse.json()) as {
      data?: { organization?: { id?: string } }[];
    };
    const activeOrgIds = (membershipPayload.data ?? [])
      .map((row) => row.organization?.id)
      .filter((id): id is string => Boolean(id));
    const rows = await query(
      "select org_id, role_id from wewebplus.memberships where user_id = $1",
      [user.userId],
    );
    const session = formaSession({
      userId: user.userId,
      memberships: rows,
      activeOrgIds,
      orgNames: {},
    });
    if (!session.role) return session;
    const orgId = rows.find(
      (row) => gateRole(row.role_id) && activeOrgIds.includes(String(row.org_id)),
    )?.org_id;
    if (!orgId) return session;
    const nameResponse = await fetchImpl(
      `https://api.clerk.com/v1/organizations/${encodeURIComponent(String(orgId))}`,
      { headers: { Authorization: `Bearer ${secret}` } },
    );
    if (!nameResponse.ok) return session;
    const organization = (await nameResponse.json()) as { name?: string };
    return { ...session, organization: organization.name ?? null };
  } catch {
    return signedOut;
  }
}
