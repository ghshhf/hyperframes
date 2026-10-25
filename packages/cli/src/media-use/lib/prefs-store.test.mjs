import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PREFERENCE_KEYS,
  mergedPreferences,
  preferenceKeyFor,
  projectPrefsPath,
  recordPreference,
  userPrefsPath,
} from "./prefs-store.mjs";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "mu-prefs-"));
  const home = join(root, "home");
  const projectA = join(root, "proj-a");
  const projectB = join(root, "proj-b");
  mkdirSync(home, { recursive: true });
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  process.env.HYPERFRAMES_MEDIA_HOME = home;
  return { root, home, projectA, projectB };
}

function restoreEnv(saved) {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
}

function withSandbox(fn) {
  const savedEnv = { ...process.env };
  const box = sandbox();
  try {
    fn(box);
  } finally {
    restoreEnv(savedEnv);
    rmSync(box.root, { recursive: true, force: true });
  }
}

test("record writes the project tier and get merges it as source=project", () => {
  withSandbox(({ projectA }) => {
    const result = recordPreference({ projectDir: projectA, key: "destination", value: "x-feed" });
    assert.equal(result.promoted, false);
    assert.deepEqual(result.confirmed_in, ["proj-a"]);

    const merged = mergedPreferences(projectA);
    assert.equal(merged.destination.value, "x-feed");
    assert.equal(merged.destination.source, "project");

    const onDisk = JSON.parse(readFileSync(projectPrefsPath(projectA), "utf8"));
    assert.equal(onDisk.preferences.destination.value, "x-feed");
  });
});

test("one project never promotes: a fresh project sees nothing user-tier", () => {
  withSandbox(({ projectA, projectB }) => {
    recordPreference({ projectDir: projectA, key: "destination", value: "x-feed" });
    // proj-b has no project entry, and the value was only confirmed once.
    assert.equal(mergedPreferences(projectB).destination, undefined);
  });
});

test("the same value confirmed in two projects promotes to the user tier", () => {
  withSandbox(({ projectA, projectB }) => {
    recordPreference({ projectDir: projectA, key: "destination", value: "x-feed" });
    const second = recordPreference({ projectDir: projectB, key: "destination", value: "x-feed" });
    assert.equal(second.promoted, true);

    const userFile = JSON.parse(readFileSync(userPrefsPath(), "utf8"));
    assert.deepEqual(userFile.preferences.destination.confirmed_in.sort(), ["proj-a", "proj-b"]);

    // A third project with no local entry now inherits the promoted default.
    const projectC = join(projectA, "..", "proj-c");
    mkdirSync(projectC, { recursive: true });
    const merged = mergedPreferences(projectC);
    assert.equal(merged.destination.value, "x-feed");
    assert.equal(merged.destination.source, "user");
  });
});

test("record is idempotent per project — confirmed_in stays deduped", () => {
  withSandbox(({ projectA }) => {
    recordPreference({ projectDir: projectA, key: "language", value: "zh" });
    const again = recordPreference({ projectDir: projectA, key: "language", value: "zh" });
    assert.deepEqual(again.confirmed_in, ["proj-a"]);
    assert.equal(again.promoted, false);
  });
});

test("a changed value restarts provenance instead of inheriting confirmations", () => {
  withSandbox(({ projectA, projectB }) => {
    recordPreference({ projectDir: projectA, key: "destination", value: "x-feed" });
    recordPreference({ projectDir: projectB, key: "destination", value: "x-feed" });
    const switched = recordPreference({
      projectDir: projectA,
      key: "destination",
      value: "youtube",
    });
    assert.deepEqual(switched.confirmed_in, ["proj-a"]);
    assert.equal(switched.promoted, false);
    // The previously promoted value keeps serving other projects until youtube
    // earns its own two confirmations.
    const userFile = JSON.parse(readFileSync(userPrefsPath(), "utf8"));
    assert.equal(userFile.preferences.destination.value, "x-feed");
  });
});

test("project tier overrides a promoted user-tier value", () => {
  withSandbox(({ projectA, projectB }) => {
    recordPreference({ projectDir: projectA, key: "storyboard", value: "yes" });
    recordPreference({ projectDir: projectB, key: "storyboard", value: "yes" });
    recordPreference({ projectDir: projectA, key: "storyboard", value: "no" });
    const merged = mergedPreferences(projectA);
    assert.equal(merged.storyboard.value, "no");
    assert.equal(merged.storyboard.source, "project");
  });
});

test("the retired mode key is rejected", () => {
  withSandbox(({ projectA }) => {
    assert.throws(
      () => recordPreference({ projectDir: projectA, key: "mode", value: "collaborative" }),
      /unknown preference key/,
    );
  });
});

test("the run-shape keys record and promote like any field", () => {
  withSandbox(({ projectA, projectB }) => {
    recordPreference({ projectDir: projectA, key: "flow", value: "automation" });
    const promoted = recordPreference({ projectDir: projectB, key: "flow", value: "automation" });
    assert.equal(promoted.promoted, true);
    recordPreference({ projectDir: projectA, key: "storyboard", value: "yes" });
    const merged = mergedPreferences(projectA);
    assert.equal(merged.flow.value, "automation");
    assert.equal(merged.storyboard.value, "yes");
    assert.equal(merged.storyboard.source, "project");
  });
});

test("style_preset is keyed per workflow", () => {
  withSandbox(({ projectA }) => {
    assert.equal(
      preferenceKeyFor("style_preset", "faceless-explainer"),
      "style_preset.faceless-explainer",
    );
    assert.equal(preferenceKeyFor("destination", "faceless-explainer"), "destination");
    recordPreference({
      projectDir: projectA,
      key: "style_preset",
      value: "pin-and-paper",
      workflow: "faceless-explainer",
    });
    const merged = mergedPreferences(projectA);
    assert.equal(merged["style_preset.faceless-explainer"].value, "pin-and-paper");
    assert.equal(merged["style_preset"], undefined);
  });
});

test("style_preset without a workflow is rejected, never stored bare", () => {
  withSandbox(({ projectA }) => {
    assert.throws(
      () => recordPreference({ projectDir: projectA, key: "style_preset", value: "pin-and-paper" }),
      /pass --workflow/,
    );
    assert.deepEqual(mergedPreferences(projectA), {});
  });
});

test("unknown keys and empty values are rejected", () => {
  withSandbox(({ projectA }) => {
    assert.throws(() => recordPreference({ projectDir: projectA, key: "vibe", value: "x" }));
    assert.throws(() => recordPreference({ projectDir: projectA, key: "voice", value: "  " }));
  });
});

test("corrupt files are treated as empty instead of crashing", () => {
  withSandbox(({ projectA, home }) => {
    mkdirSync(join(projectA, ".media"), { recursive: true });
    writeFileSync(projectPrefsPath(projectA), "not json");
    mkdirSync(join(home, ".media"), { recursive: true });
    writeFileSync(userPrefsPath(), '{"preferences": 42}');
    assert.deepEqual(mergedPreferences(projectA), {});
    const result = recordPreference({ projectDir: projectA, key: "language", value: "zh" });
    assert.equal(result.value, "zh");
  });
});

// A separate process per writer is the point: the lost update this guards
// against happens between processes (parallel agents, CLI + skill), which an
// in-process async test cannot reproduce.
async function recordInChild(project, key, env) {
  const moduleUrl = new URL("./prefs-store.mjs", import.meta.url).href;
  const script = [
    "const { recordPreference } = await import(process.argv[1]);",
    'recordPreference({ projectDir: process.argv[2], key: process.argv[3], value: "v" });',
  ].join("\n");
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", script, moduleUrl, project, key],
    { env, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  assert.equal(code, 0, `child recording "${key}" failed: ${stderr}`);
}

test("concurrent recorders keep every key instead of losing the slow one", async () => {
  const savedEnv = { ...process.env };
  const root = mkdtempSync(join(tmpdir(), "mu-prefs-race-"));
  const home = join(root, "home");
  const project = join(root, "proj-race");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  process.env.HYPERFRAMES_MEDIA_HOME = home;
  try {
    const keys = PREFERENCE_KEYS.filter((key) => key !== "style_preset");
    const env = { ...process.env, HYPERFRAMES_MEDIA_HOME: home };
    await Promise.all(keys.map((key) => recordInChild(project, key, env)));

    const onDisk = JSON.parse(readFileSync(projectPrefsPath(project), "utf8"));
    assert.deepEqual(Object.keys(onDisk.preferences).sort(), [...keys].sort());
  } finally {
    restoreEnv(savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the lock and its temp file are cleaned up, so .media stays committable", () => {
  withSandbox(({ projectA }) => {
    recordPreference({ projectDir: projectA, key: "language", value: "zh" });
    const prefs = projectPrefsPath(projectA);
    assert.equal(existsSync(`${prefs}.lock`), false);
    assert.equal(existsSync(`${prefs}.${process.pid}.tmp`), false);
  });
});
