/**
 * Settings resolve in the right order, and cannot be written where they would
 * be silently overwritten.
 *
 * Two properties carry the whole design:
 *
 *   1. ENVIRONMENT WINS. On Home Assistant OS, run.sh translates Supervisor's
 *      options into env vars. If the settings file could override them, an
 *      edit here would quietly diverge from what the Configuration tab shows —
 *      two sources of truth for one value, which is how public_url got blanked
 *      on a live guest and broke every OAuth client.
 *
 *   2. SUPERVISOR MEANS READ-ONLY. Supervisor rewrites its own options on
 *      every change, so an app-side write would appear to succeed and then
 *      vanish on its next write. A form that loses edits is worse than one
 *      that refuses them, so the refusal is enforced here rather than left to
 *      the UI to remember.
 *
 * ⚠️ Run test FILES in separate processes (`bun run test`). config.ts reads its
 * file once at import, so a second test file in the same process would see the
 * first file's settings no matter what its own env said.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "arra-config-test-"));
const settingsPath = join(dir, "settings.json");

// A file that sets three things, one of which the environment also pins.
writeFileSync(
  settingsPath,
  JSON.stringify({
    instance_name: "from-file",
    ollama_url: "http://from-file:11434",
    embedding_model: "from-file-model",
  }),
);

process.env.SETTINGS_PATH = settingsPath;
process.env.INSTANCE_NAME = "from-env";   // pins one key
delete process.env.OLLAMA_URL;            // leaves another to the file
delete process.env.MANAGED_BY;            // not supervised → writable

const config = await import("./config");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("environment beats the settings file", () => {
  expect(config.setting("instance_name")).toBe("from-env");
  expect(config.sourceOf("instance_name")).toBe("environment");
  expect(config.pinnedByEnv("instance_name")).toBe(true);
});

test("the settings file fills in what the environment does not set", () => {
  expect(config.setting("ollama_url")).toBe("http://from-file:11434");
  expect(config.sourceOf("ollama_url")).toBe("settings");
  expect(config.pinnedByEnv("ollama_url")).toBe(false);
});

test("an unset option resolves to empty, not to the string 'undefined'", () => {
  // bashio renders an unset optional as the literal "null", and this codebase
  // has already been bitten by that becoming a valid-looking passphrase.
  expect(config.setting("mqtt_url")).toBe("");
  expect(config.sourceOf("mqtt_url")).toBe("unset");
});

test("writing skips keys the environment pins, and says which", async () => {
  const r = await config.writeSettings({
    instance_name: "should-be-ignored",   // pinned by env
    embedding_model: "written-model",     // free
  });
  expect(r.ignored).toContain("instance_name");
  expect(r.written).toContain("embedding_model");
  // The env value still wins after the write — the file did not quietly
  // become the source of truth for a pinned key.
  expect(config.setting("instance_name")).toBe("from-env");
  expect(config.setting("embedding_model")).toBe("written-model");
});

test("secrets are described by LENGTH, never returned", () => {
  process.env.API_TOKEN = "super-secret-value";
  const d = config.describeSettings();
  const tok = d.settings.find((s) => s.key === "api_token")!;
  expect(tok.secret).toBe(true);
  expect(tok.value).toBe("<set:18>");
  expect(JSON.stringify(d)).not.toContain("super-secret-value");
  delete process.env.API_TOKEN;
});

test("without Supervisor, settings are writable", () => {
  expect(config.SUPERVISED).toBe(false);
  expect(config.settingsWritable().writable).toBe(true);
});
