export const AUTH_RELAY_MESSAGE_TYPE = "uos_ai.admin_auth_relay";
export const AUTH_RELAY_ACTION_PASSKEY_LOGIN = "passkey-login";

const DENO_PREVIEW_SUFFIX = "[a-z0-9]{12}";
const TRUSTED_DENO_APPLICATIONS = new Map([
  ["ubiquity-dao", new Set(["ai-ubq-fi", "p-ai-ubq-fi"])],
  ["0x4007", new Set(["telegram-daily-exporter"])],
  ["ubiquity-os", new Set(["agent-worker"])],
]);

const isTrustedDenoApplicationHost = (hostname) => {
  const labels = hostname.split(".");
  if (labels.length !== 4) return false;
  const [app, organization, platform, topLevelDomain] = labels;
  if (platform !== "deno" || topLevelDomain !== "net") return false;
  const trustedApps = TRUSTED_DENO_APPLICATIONS.get(organization);
  if (!trustedApps) return false;
  for (const trustedApp of trustedApps) {
    if (app === trustedApp || new RegExp(`^${trustedApp}-${DENO_PREVIEW_SUFFIX}$`).test(app)) return true;
  }
  return false;
};

const isAiGatewayDeployHost = (hostname) =>
  hostname === "ai.ubq.fi" ||
  hostname === "ai-ubq-fi.deno.dev" ||
  new RegExp(`^ai-ubq-fi-${DENO_PREVIEW_SUFFIX}\\.deno\\.dev$`).test(hostname) ||
  isTrustedDenoApplicationHost(hostname);

export const isTrustedAuthRelayClientOrigin = (value) => {
  try {
    const url = new URL(String(value ?? ""));
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      !url.port &&
      url.origin === String(value ?? "").replace(/\/+$/g, "") &&
      (hostname === "ai-ubq-fi.deno.dev" ||
        new RegExp(`^ai-ubq-fi-${DENO_PREVIEW_SUFFIX}\\.deno\\.dev$`).test(hostname) ||
        isTrustedDenoApplicationHost(hostname))
    );
  } catch {
    return false;
  }
};

export const parseTrustedAuthRelayOrigin = (value) => {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.port || url.origin !== raw.replace(/\/+$/g, "")) {
      return "";
    }
    if (isAiGatewayDeployHost(hostname)) return url.origin;
    return "";
  } catch {
    return "";
  }
};

export const parseAuthRelayAction = (value) =>
  value === AUTH_RELAY_ACTION_PASSKEY_LOGIN ? AUTH_RELAY_ACTION_PASSKEY_LOGIN : "";
