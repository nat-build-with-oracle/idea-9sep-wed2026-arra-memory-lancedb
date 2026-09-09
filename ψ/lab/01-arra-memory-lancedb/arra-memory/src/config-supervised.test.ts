/**
 * Under Supervisor, settings are read-only — enforced, not merely advised.
 *
 * A separate file because `MANAGED_BY` has to be set BEFORE config.ts is
 * imported, and config.ts resolves `SUPERVISED` once at import. Two states of
 * one module-level constant cannot coexist in a process, so they cannot
 * coexist in a file either.
 *
 * This is the case that protects a real deployment: on Home Assistant OS,
 * Supervisor rewrites its options on every change. An app-side write would
 * look successful and then disappear the next time anyone touched the
 * Configuration tab — a silent overwrite, which is the failure mode this
 * codebase has paid for twice already.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "arra-supervised-test-"));

process.env.SETTINGS_PATH = join(dir, "settings.json");
process.env.MANAGED_BY = "supervisor";     // what run.sh exports on HAOS

const config = await import("./config");

afterAll(() => {
  delete process.env.MANAGED_BY;
  rmSync(dir, { recursive: true, force: true });
});

test("run.sh's marker is what identifies a supervised deployment", () => {
  expect(config.SUPERVISED).toBe(true);
});

test("settings are refused, with a reason that points at the right place", () => {
  const { writable, reason } = config.settingsWritable();
  expect(writable).toBe(false);
  // The message has to send the reader to the Configuration tab; "read only"
  // alone would leave them with no way to change the thing they came to change.
  expect(reason).toContain("Configuration tab");
  expect(reason).toContain("Supervisor");
});

test("describeSettings reports the read-only state so a UI can render it", () => {
  const d = config.describeSettings();
  expect(d.supervised).toBe(true);
  expect(d.writable).toBe(false);
  expect(d.settings.length).toBe(config.SETTING_KEYS.length);
});
