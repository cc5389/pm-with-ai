import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, getSettings, saveSettings } from "../lib/db";

test("local development still creates a filesystem SQLite workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-local-storage-"));
  const path = join(root, "nested", "workspace.sqlite");
  process.env.ORCHESTRA_DB_PATH = path;
  try {
    saveSettings({ ...getSettings(), teamName: "Persistent local workspace" });
    assert.ok(existsSync(path));
    assert.equal(getSettings().teamName, "Persistent local workspace");
  } finally {
    db().close();
    rmSync(root, { recursive: true, force: true });
    delete process.env.ORCHESTRA_DB_PATH;
  }
});
