import { invoke } from "@tauri-apps/api/core";
import { androidFetch, isAndroidApp } from "@/lib/android";
// The relay itself, sent to Cloudflare as it is (the desktop app bundles the same file).
import workerSource from "../../../relay/worker.js?raw";

export type CfAccount = { id: string; name: string };

export type DeployResult = {
  url: string;
  account_id: string;
  script_name: string;
  subdomain: string;
};

const NOT_NATIVE_MSG =
  "Relay deploy is only available in the Harbor desktop and Android apps. Open Harbor outside the browser to continue.";

const hasTauri = () =>
  typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/** Whether this build can deploy a relay itself (the desktop app, or the Android app). */
export function canDeployRelay(): boolean {
  return hasTauri() || isAndroidApp();
}

function ensureNative(): void {
  if (!canDeployRelay()) throw new Error(NOT_NATIVE_MSG);
}

export function listAccounts(apiToken: string): Promise<CfAccount[]> {
  ensureNative();
  if (!hasTauri()) return android.listAccounts(apiToken);
  return invoke<CfAccount[]>("cf_list_accounts", { apiToken });
}

export function deployRelay(apiToken: string, accountId: string): Promise<DeployResult> {
  ensureNative();
  if (!hasTauri()) return android.deployRelay(apiToken, accountId);
  return invoke<DeployResult>("cf_deploy_relay", { apiToken, accountId });
}

export function deleteRelay(apiToken: string, accountId: string): Promise<void> {
  ensureNative();
  if (!hasTauri()) return android.deleteRelay(apiToken, accountId);
  return invoke("cf_delete_relay", { apiToken, accountId });
}

export function relayStatus(apiToken: string, accountId: string): Promise<boolean> {
  ensureNative();
  if (!hasTauri()) return android.relayStatus(apiToken, accountId);
  return invoke<boolean>("cf_relay_status", { apiToken, accountId });
}

/**
 * The same steps as the desktop app (src-tauri's cf_relay.rs), for the Android app: Cloudflare's
 * API takes no requests from a web page, so they go through the app's own network stack.
 */
const android = (() => {
  const SCRIPT_NAME = "harbor-together-relay";
  const CF_BASE = "https://api.cloudflare.com/client/v4";
  const NAMESPACE_RETRY_BACKOFF_MS = [1500, 2500, 4000, 6000, 8000, 10000];

  type CfBody = { success?: boolean; result?: unknown; errors?: Array<{ code?: number; message?: string }> };

  async function call(
    token: string,
    path: string,
    init: { method?: string; body?: string; contentType?: string } = {},
  ): Promise<{ ok: boolean; status: number; body: CfBody }> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (init.contentType) headers["Content-Type"] = init.contentType;
    let res: Response;
    try {
      res = await androidFetch(`${CF_BASE}${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body,
        timeoutMs: 60_000,
      });
    } catch (e) {
      throw new Error(`network error: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text().catch(() => "");
    let body: CfBody = {};
    try {
      body = JSON.parse(text) as CfBody;
    } catch {
      body = {};
    }
    return { ok: res.ok, status: res.status, body };
  }

  function cfError(body: CfBody): string {
    const first = body.errors?.[0];
    return first ? `Cloudflare error ${first.code ?? 0}: ${first.message ?? "unknown"}` : "Cloudflare request failed";
  }

  async function listAccounts(token: string): Promise<CfAccount[]> {
    const { body } = await call(token, "/accounts");
    if (!body.success) throw new Error(cfError(body));
    const arr = Array.isArray(body.result) ? (body.result as Array<{ id?: string; name?: string }>) : [];
    return arr.filter((a) => a.id).map((a) => ({ id: a.id!, name: a.name || "Account" }));
  }

  async function subdomainOf(token: string, accountId: string): Promise<string> {
    const { body } = await call(token, `/accounts/${accountId}/workers/subdomain`);
    const sub = (body.result as { subdomain?: string } | undefined)?.subdomain;
    if (sub) return sub;
    throw new Error("This Cloudflare account doesn't have a workers.dev subdomain yet.");
  }

  async function scriptExists(token: string, accountId: string): Promise<boolean> {
    return (await call(token, `/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}`)).ok;
  }

  /** The worker and its settings as one multipart upload (a text body the app can send). */
  async function upload(token: string, accountId: string, metadata: object): Promise<void> {
    const boundary = `----harbor${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="worker.js"; filename="worker.js"\r\n` +
      `Content-Type: application/javascript+module\r\n\r\n${workerSource}\r\n` +
      `--${boundary}--\r\n`;
    const r = await call(token, `/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}`, {
      method: "PUT",
      body,
      contentType: `multipart/form-data; boundary=${boundary}`,
    });
    if (!r.ok) throw new Error(cfError(r.body));
  }

  const needsMigrationFallback = (e: string) =>
    e.includes("10074") || e.includes("already depend") || e.includes("missing_migration");
  const isNamespacePropagating = (e: string) =>
    e.includes("10065") || (e.includes("already in use") && e.includes("namespace"));

  async function deployRelay(token: string, accountId: string): Promise<DeployResult> {
    const subdomain = await subdomainOf(token, accountId);
    const exists = await scriptExists(token, accountId);
    const bindings = [{ type: "durable_object_namespace", name: "ROOM", class_name: "Room" }];
    const withMigrations = {
      main_module: "worker.js",
      compatibility_date: "2026-05-01",
      bindings,
      migrations: { tag: "v1", new_sqlite_classes: ["Room"] },
    };
    const withoutMigrations = { main_module: "worker.js", compatibility_date: "2026-05-01", bindings };
    const primary = exists ? withoutMigrations : withMigrations;
    const fallback = exists ? withMigrations : withoutMigrations;

    let lastErr: string | null = null;
    for (let attempt = 0; attempt <= NAMESPACE_RETRY_BACKOFF_MS.length; attempt++) {
      try {
        await upload(token, accountId, primary);
        lastErr = null;
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (needsMigrationFallback(msg)) {
          await upload(token, accountId, fallback);
          lastErr = null;
          break;
        }
        if (!isNamespacePropagating(msg)) throw e;
        lastErr = msg;
        if (attempt === NAMESPACE_RETRY_BACKOFF_MS.length) break;
        await new Promise((r) => setTimeout(r, NAMESPACE_RETRY_BACKOFF_MS[attempt]));
      }
    }
    if (lastErr) throw new Error(lastErr);

    const route = await call(token, `/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}/subdomain`, {
      method: "POST",
      body: JSON.stringify({ enabled: true }),
      contentType: "application/json",
    });
    if (!route.ok) throw new Error(cfError(route.body));

    return {
      url: `wss://${SCRIPT_NAME}.${subdomain}.workers.dev`,
      account_id: accountId,
      script_name: SCRIPT_NAME,
      subdomain,
    };
  }

  async function deleteRelay(token: string, accountId: string): Promise<void> {
    const r = await call(token, `/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}?force=true`, { method: "DELETE" });
    if (r.ok || r.status === 404) return;
    throw new Error(cfError(r.body));
  }

  async function relayStatus(token: string, accountId: string): Promise<boolean> {
    return scriptExists(token, accountId);
  }

  return { listAccounts, deployRelay, deleteRelay, relayStatus };
})();
