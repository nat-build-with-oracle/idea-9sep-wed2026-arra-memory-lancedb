/**
 * Where a setting comes from, and who is allowed to change it.
 *
 * Until 0.24.0 every option was read straight from `process.env`, which meant
 * the only thing that could change one was Supervisor. That is fine on Home
 * Assistant OS — the add-on Configuration tab is right there — and it is a dead
 * end everywhere else. Run this image under plain Docker and there is no form,
 * no Supervisor, and no way to change a setting except editing a compose file
 * and recreating the container.
 *
 * ── precedence ───────────────────────────────────────────────────────────────
 *
 *   environment  >  /data/settings.json  >  built-in default
 *
 * Environment wins on purpose. On HAOS, `run.sh` translates Supervisor's
 * options into env vars, so Supervisor stays authoritative and nothing about
 * that deployment changes. Under Docker, whatever the compose file pins stays
 * pinned. `settings.json` fills in the rest.
 *
 * ── why a separate file, and never options.json ──────────────────────────────
 *
 * Supervisor owns `/data/options.json`. Writing to it would make two processes
 * authors of one file, and Supervisor would silently win on its next write —
 * the exact silent-overwrite class this codebase has been bitten by twice. So
 * we keep our own file and never touch theirs.
 *
 * ── read once, at startup ────────────────────────────────────────────────────
 *
 * Deliberately not hot-reloaded. Supervisor's own semantics are that options
 * take effect at add-on start, and matching that is simpler to reason about
 * than half the process seeing a new passphrase. The settings endpoint says
 * `restartRequired` so a UI can be honest about it.
 */

const SETTINGS_PATH = process.env.SETTINGS_PATH ?? "/data/settings.json";

/**
 * True when Supervisor is managing this container.
 *
 * Set by `run.sh`, which is the Supervisor entrypoint — so it is present
 * exactly when Supervisor started us, and absent when the image is run
 * directly. Detecting it any other way (probing a hostname, sniffing for
 * bashio) guesses at the environment; this asks the one component that knows.
 */
export const SUPERVISED = process.env.MANAGED_BY === "supervisor";

/** Every option the add-on accepts, mirroring config.yaml's schema block. */
export const SETTING_KEYS = [
  "owner_passphrase",
  "api_token",
  "public_url",
  "instance_name",
  "ollama_url",
  "embedding_model",
  "embedding_dimensions",
  "search_log",
  "generated_tools",
  "language",
  "theme",
  // The fleet, over MQTT. Blank mqtt_url disables the fleet tools entirely —
  // they are not offered rather than offered-and-failing, because a tool that
  // always errors costs every client context on every request.
  "mqtt_url",
  "mqtt_username",
  "mqtt_password",
  "mqtt_prefix",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

/** Values a leak would cost a rotation. Masked in responses, never returned. */
export const SECRET_KEYS = new Set<SettingKey>([
  "owner_passphrase",
  "api_token",
  "mqtt_password",
]);

/**
 * Only the settings that are genuinely stale until the process restarts.
 *
 * Marking everything was over-broad and actively misleading: five of these
 * are read on every request and take effect the moment they are saved, and
 * telling someone to restart for a change that already happened teaches them
 * to distrust the label on the ones that need it.
 *
 * These are here because something reads them ONCE, at module load:
 *   owner_passphrase, api_token   → the auth config object in server.ts
 *   instance_name                 → the INSTANCE_NAME constant
 *   ollama_url, embedding_*       → the embedding provider is resolved and cached,
 *                                   and the vector column is sized at open
 *
 * Live by contrast: public_url and language/theme are read per request,
 * search_log per call, and generated_tools every time the tool list is built.
 */
export const RESTART_REQUIRED = new Set<SettingKey>([
  "owner_passphrase",
  "api_token",
  "instance_name",
  "ollama_url",
  "embedding_model",
  "embedding_dimensions",
  // The broker connection is opened once at startup.
  "mqtt_url",
  "mqtt_username",
  "mqtt_password",
  "mqtt_prefix",
]);

let fileSettings: Partial<Record<SettingKey, string>> = {};

/** Loaded once, at import. A malformed file is ignored, never fatal — a bad
 *  settings file must not cost you the corpus. */
try {
  const raw = require("node:fs").readFileSync(SETTINGS_PATH, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  for (const k of SETTING_KEYS) {
    const v = parsed[k];
    if (v !== undefined && v !== null && v !== "") fileSettings[k] = String(v);
  }
} catch {
  // Absent or unreadable is the normal case on HAOS and on a first run.
}

const ENV_OF: Record<SettingKey, string> = {
  owner_passphrase: "OWNER_PASSPHRASE",
  api_token: "API_TOKEN",
  public_url: "PUBLIC_URL",
  instance_name: "INSTANCE_NAME",
  ollama_url: "OLLAMA_URL",
  embedding_model: "EMBEDDING_MODEL",
  embedding_dimensions: "EMBEDDING_DIMENSIONS",
  search_log: "SEARCH_LOG",
  generated_tools: "GENERATED_TOOLS",
  language: "LANGUAGE",
  theme: "THEME",
  mqtt_url: "MQTT_URL",
  mqtt_username: "MQTT_USERNAME",
  mqtt_password: "MQTT_PASSWORD",
  mqtt_prefix: "MQTT_PREFIX",
};

/** The resolved value, or "" — env first, then the settings file. */
export function setting(key: SettingKey): string {
  const fromEnv = process.env[ENV_OF[key]]?.trim();
  if (fromEnv) return fromEnv;
  return fileSettings[key]?.trim() ?? "";
}

/** Where a value actually came from — what a settings UI needs to explain
 *  why a field it just wrote did not change anything. */
export function sourceOf(key: SettingKey): "environment" | "settings" | "unset" {
  if (process.env[ENV_OF[key]]?.trim()) return "environment";
  if (fileSettings[key]?.trim()) return "settings";
  return "unset";
}

/**
 * Whether this deployment may write settings at all.
 *
 * Under Supervisor the answer is no, and that is not timidity: Supervisor
 * rewrites its own options on every change, so an app-side edit would appear
 * to work and then vanish. A read-only form pointing at the Configuration tab
 * is honest; a writable one that loses edits is not.
 */
export function settingsWritable(): { writable: boolean; reason: string } {
  if (SUPERVISED) {
    return {
      writable: false,
      reason:
        "Supervisor manages this add-on's options. Use the Configuration tab — " +
        "an edit made here would be overwritten by Supervisor's next write.",
    };
  }
  return { writable: true, reason: "" };
}

/** A key pinned by the environment cannot be changed by writing the file. */
export function pinnedByEnv(key: SettingKey): boolean {
  return Boolean(process.env[ENV_OF[key]]?.trim());
}

/** Merge a patch into the settings file. Caller has already authorised. */
export async function writeSettings(
  patch: Partial<Record<SettingKey, string>>,
): Promise<{ written: SettingKey[]; ignored: SettingKey[] }> {
  const written: SettingKey[] = [];
  const ignored: SettingKey[] = [];
  const next = { ...fileSettings };

  for (const [k, v] of Object.entries(patch) as [SettingKey, string][]) {
    if (!SETTING_KEYS.includes(k)) continue;
    // Writing a key the environment pins would be a lie: the file would say
    // one thing and the running server another. Report it instead.
    if (pinnedByEnv(k)) { ignored.push(k); continue; }
    if (v === "") delete next[k];
    else next[k] = v;
    written.push(k);
  }

  const fs = require("node:fs");
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  // Keep the in-process view consistent with the file, even though the running
  // server will not act on it until restart.
  fileSettings = next;
  return { written, ignored };
}

/** The whole surface, secrets replaced by their length. */
export function describeSettings() {
  return {
    supervised: SUPERVISED,
    ...settingsWritable(),
    settings: SETTING_KEYS.map((key) => {
      const value = setting(key);
      return {
        key,
        secret: SECRET_KEYS.has(key),
        // A secret's LENGTH is safe and useful — it distinguishes "set" from
        // "set to the wrong thing" without printing it.
        value: SECRET_KEYS.has(key) ? (value ? `<set:${value.length}>` : "") : value,
        source: sourceOf(key),
        pinnedByEnv: pinnedByEnv(key),
        restartRequired: RESTART_REQUIRED.has(key),
      };
    }),
  };
}
