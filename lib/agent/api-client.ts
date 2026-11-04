import type { ApiGet } from "./types";

// The agent reads data the same way the app does: through our API, with the teacher's own token.
// So every login and ownership check still applies, and a teacher can only reach their own data.
// The token stays on our server; it's never sent to Gemini.
export function createApiGet(origin: string, token: string): ApiGet {
  return async (path) => {
    const response = await fetch(`${origin}/api/v1${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error?.message ?? `The request failed (${response.status}).`);
    return body;
  };
}
