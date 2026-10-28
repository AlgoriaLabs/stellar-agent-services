// The terminal's session API (src/cli/approval.ts): JSON in and out, authorized by the session's token.
// The token arrives in the link's fragment, which never leaves the browser. The page takes it out of the
// address bar at once and keeps it in this tab's storage, so a reload still works.

import type { ApprovalView } from "../../../src/cli/approval-view.js";

/** The terminal stopped answering: the command finished, was cancelled or was stopped. */
export class SessionEnded extends Error {
  override name = "SessionEnded";
}

const TOKEN_KEY = "provider-kit:approval-token";

/** The session's token, or undefined when the page was opened without the terminal's link. */
export function sessionToken(): string | undefined {
  const fragment = location.hash.slice(1);
  if (fragment !== "") {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    try {
      sessionStorage.setItem(TOKEN_KEY, fragment);
    } catch {
      // Storage is blocked: the page works until it is reloaded.
    }
    return fragment;
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export interface SessionApi {
  session(): Promise<ApprovalView>;
  connect(address: string, wallet: string): Promise<ApprovalView>;
  submit(stepId: string, signedTxXdr: string): Promise<ApprovalView>;
  rebuild(stepId: string): Promise<ApprovalView>;
  cancel(): Promise<ApprovalView>;
}

export function sessionApi(token: string): SessionApi {
  async function call(path: string, body?: Record<string, string>): Promise<ApprovalView> {
    let response: Response;
    try {
      response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? { Authorization: `Bearer ${token}` } : { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: "no-store",
      });
    } catch {
      throw new SessionEnded("The terminal isn't answering.");
    }
    if (response.status === 401) throw new SessionEnded("This link isn't valid anymore.");
    const data = (await response.json().catch(() => undefined)) as (ApprovalView & { message?: string; view?: ApprovalView }) | undefined;
    if (response.ok && data !== undefined) return data;
    // A request the session can't take right now: it answers with where it stands instead.
    if (response.status === 409 && data?.view !== undefined) return data.view;
    throw new Error(data?.message ?? `The terminal answered ${response.status}.`);
  }

  return {
    session: () => call("/api/session"),
    connect: (address, wallet) => call("/api/connect", { address, wallet }),
    submit: (stepId, signedTxXdr) => call("/api/submit", { stepId, signedTxXdr }),
    rebuild: (stepId) => call("/api/rebuild", { stepId }),
    cancel: () => call("/api/cancel", {}),
  };
}
