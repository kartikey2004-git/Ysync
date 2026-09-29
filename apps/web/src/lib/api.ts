const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

export interface DocumentInfo {
  id: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}

export interface Member {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (res.status === 401) {
    if (typeof window !== "undefined") {
      window.location.href = `/auth/signin?redirect=${encodeURIComponent(window.location.pathname)}`;
    }
    throw new ApiError(401, "Unauthenticated");
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiError(res.status, body || res.statusText);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function createDocument(): Promise<{ id: string; role: string }> {
  return request("/api/documents", { method: "POST" });
}

export function listDocuments(): Promise<DocumentInfo[]> {
  return request("/api/documents");
}

export function getDocument(id: string): Promise<DocumentInfo> {
  return request(`/api/documents/${encodeURIComponent(id)}`);
}

export function deleteDocument(id: string): Promise<void> {
  return request(`/api/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function listMembers(docId: string): Promise<Member[]> {
  return request(`/api/documents/${encodeURIComponent(docId)}/members`);
}

export function addMember(docId: string, email: string, role: string): Promise<Member> {
  return request(`/api/documents/${encodeURIComponent(docId)}/members`, {
    method: "POST",
    body: JSON.stringify({ email, role }),
  });
}

export function updateMemberRole(docId: string, userId: string, role: string): Promise<Member> {
  return request(
    `/api/documents/${encodeURIComponent(docId)}/members/${encodeURIComponent(userId)}`,
    { method: "PATCH", body: JSON.stringify({ role }) },
  );
}

export function removeMember(docId: string, userId: string): Promise<void> {
  return request(
    `/api/documents/${encodeURIComponent(docId)}/members/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
}

export function transferOwnership(docId: string, newOwnerId: string): Promise<void> {
  return request(`/api/documents/${encodeURIComponent(docId)}/transfer-ownership`, {
    method: "POST",
    body: JSON.stringify({ newOwnerId }),
  });
}

export { ApiError };
