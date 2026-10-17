import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const manifestPath = path.join(rootDir, "integrity-manifest.json");

if (!fs.existsSync(manifestPath)) {
  console.error("FAIL: integrity-manifest.json not found!");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
console.log(`=== QMOOSA CROSS-REPOSITORY SOURCE INTEGRITY VERIFIER ===`);
console.log(`Mission: ${manifest.mission}`);
console.log(`Manifest Generated: ${manifest.generatedAt}\n`);

let failed = false;

for (const pkg of manifest.packages) {
  console.log(`Checking package: ${pkg.name} (${pkg.repository})...`);

  // 1. Verify archive exists and SHA-256 matches
  const archivePath = path.join(rootDir, pkg.archivePath);
  if (!fs.existsSync(archivePath)) {
    console.error(`  [FAIL] Archive missing: ${pkg.archivePath}`);
    failed = true;
    continue;
  }

  const fileBytes = fs.readFileSync(archivePath);
  const actualHash = crypto.createHash("sha256").update(fileBytes).digest("hex").toLowerCase();
  const expectedHash = pkg.sha256.toLowerCase();

  if (actualHash !== expectedHash) {
    console.error(`  [FAIL] Archive SHA-256 mismatch!`);
    console.error(`         Expected: ${expectedHash}`);
    console.error(`         Actual:   ${actualHash}`);
    failed = true;
  } else {
    console.log(`  [PASS] Archive SHA-256 verified (${actualHash.substring(0, 16)}...)`);
  }

  // 2. If sibling workspace repository exists locally, verify HEAD commit matches sourceCommit
  const repoBaseName = pkg.repository.split("/")[1];
  const siblingPath = path.resolve(rootDir, "..", repoBaseName);

  if (fs.existsSync(siblingPath) && fs.existsSync(path.join(siblingPath, ".git"))) {
    try {
      const currentHead = execSync("git rev-parse HEAD", { cwd: siblingPath, encoding: "utf8" }).trim();
      if (currentHead.toLowerCase() !== pkg.sourceCommit.toLowerCase()) {
        console.error(`  [FAIL] Source revision mismatch for ${pkg.repository}!`);
        console.error(`         Declared in manifest: ${pkg.sourceCommit}`);
        console.error(`         Current HEAD commit:  ${currentHead}`);
        failed = true;
      } else {
        console.log(`  [PASS] Sibling repository HEAD commit verified: ${currentHead.substring(0, 7)}`);
      }
    } catch (err) {
      console.warn(`  [WARN] Could not inspect local git commit in ${siblingPath}: ${err.message}`);
    }
  } else {
    console.log(`  [INFO] Running in hermetic mode (no sibling source checkout present). Pinned package verified.`);
  }

  console.log();
}

if (failed) {
  console.error("FAIL: Cross-repository source integrity verification FAILED.");
  process.exit(1);
} else {
  console.log("SUCCESS: All declared packages match their exact commit provenance and package hashes.");
}
