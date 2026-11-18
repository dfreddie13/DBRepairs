const apiRoot = "/api";
const sessionTokenKey = "dbrepairs.sessionToken";

export function getSessionToken(): string | null {
  try {
    return localStorage.getItem(sessionTokenKey);
  } catch {
    return null;
  }
}

export function setSessionToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(sessionTokenKey, token);
    else localStorage.removeItem(sessionTokenKey);
  } catch {
    // Storage can be unavailable in hardened environments.
  }
}

function authHeaders(): Record<string, string> {
  const token = getSessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function notifyUnauthorized() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("dbrepairs:unauthorized"));
  }
}

async function responseError(response: Response) {
  try {
    const body = await response.json() as { error?: string };
    return body.error || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...authHeaders(),
    ...(init?.body ? { "Content-Type": "application/json" } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };
  const response = await fetch(`${apiRoot}${path}`, { ...init, headers });
  if (!response.ok) {
    if (response.status === 401) notifyUnauthorized();
    throw new Error(await responseError(response));
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

// fetch() that always sends the session token (used by the attachment modules).
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = { ...authHeaders(), ...(init.headers as Record<string, string> | undefined) };
  const response = await fetch(input, { ...init, headers });
  if (response.status === 401) notifyUnauthorized();
  return response;
}

export async function downloadApiFile(path: string): Promise<string> {
  const response = await fetch(`${apiRoot}${path}`, { headers: authHeaders() });
  if (!response.ok) {
    if (response.status === 401) notifyUnauthorized();
    throw new Error(await responseError(response));
  }
  const disposition = response.headers.get("Content-Disposition") || "";
  const filename = disposition.match(/filename=([^;]+)/i)?.[1]?.replace(/^"|"$/g, "") || "DBRepairs-backup.dump";
  downloadBlob(await response.blob(), filename);
  return filename;
}

export async function restoreApiBackup(data: ArrayBuffer): Promise<void> {
  const response = await fetch(`${apiRoot}/backups/database`, {
    method: "PUT",
    headers: { ...authHeaders(), "Content-Type": "application/octet-stream" },
    body: data,
  });
  if (!response.ok) {
    if (response.status === 401) notifyUnauthorized();
    throw new Error(await responseError(response));
  }
}

export function downloadTextFile(content: string, filename: string) {
  downloadBlob(new Blob([content], { type: "text/csv;charset=utf-8" }), filename);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
