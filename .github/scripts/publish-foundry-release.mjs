import fs from "node:fs";

const ENDPOINT = process.env.FOUNDRY_RELEASE_ENDPOINT ?? "https://foundryvtt.com/_api/packages/release_version/";
const manifest = JSON.parse(fs.readFileSync("module.json", "utf8"));
const tag = process.env.GITHUB_REF_NAME;
const validateOnly = process.argv.includes("--validate-only");

if (!tag) throw new Error("GITHUB_REF_NAME is required");
const expectedTag = `v${manifest.version}`;
if (tag !== expectedTag) {
  throw new Error(`Tag ${tag} must match manifest version ${expectedTag}`);
}

const release = {
  version: String(manifest.version),
  manifest: `${manifest.url}/releases/download/${tag}/module.json`,
  notes: `${manifest.url}/releases/tag/${tag}`,
  compatibility: {
    minimum: String(manifest.compatibility?.minimum ?? ""),
    verified: String(manifest.compatibility?.verified ?? ""),
    maximum: String(manifest.compatibility?.maximum ?? ""),
  },
};

if (!manifest.id) throw new Error("module.json id is required");
if (!manifest.url) throw new Error("module.json url is required");
if (!release.compatibility.minimum || !release.compatibility.verified) {
  throw new Error("module.json compatibility.minimum and compatibility.verified are required");
}

const expectedManifest = `${manifest.url}/releases/latest/download/module.json`;
if (manifest.manifest !== expectedManifest) {
  throw new Error(`module.json manifest must be ${expectedManifest}`);
}

if (validateOnly) {
  console.log(`PASS Foundry release payload for ${manifest.id} ${release.version}`);
  console.log(JSON.stringify({ id: manifest.id, release }, null, 2));
  process.exit(0);
}

const token = process.env.FOUNDRY_RELEASE_TOKEN;
if (!token) {
  throw new Error("Missing GitHub Actions secret FOUNDRY_RELEASE_TOKEN");
}
if (!token.startsWith("fvttp_")) {
  throw new Error("FOUNDRY_RELEASE_TOKEN does not have the expected fvttp_ prefix");
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function submit(dryRun) {
  const body = {
    id: manifest.id,
    ...(dryRun ? { "dry-run": true } : {}),
    release,
  };

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (response.status === 429 && attempt < 4) {
      const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "60", 10);
      const delaySeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60;
      console.log(`Foundry API rate limit reached; retrying in ${delaySeconds}s`);
      await sleep(delaySeconds * 1000);
      continue;
    }

    if (!response.ok || data.status !== "success") {
      throw new Error(
        `Foundry ${dryRun ? "dry-run" : "release"} request failed (${response.status}): ${JSON.stringify(data)}`,
      );
    }

    console.log(`PASS Foundry ${dryRun ? "dry-run" : "release"} for ${manifest.id} ${release.version}`);
    return data;
  }

  throw new Error(`Foundry ${dryRun ? "dry-run" : "release"} request exhausted all retries`);
}

await submit(true);
await submit(false);
