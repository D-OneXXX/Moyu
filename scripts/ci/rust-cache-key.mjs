import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const fields = [
  "ImageOS", "CARGO_BUILD_TARGET", "CARGO_ENCODED_RUSTFLAGS", "RUSTFLAGS",
  "CARGO_PROFILE_DEV_DEBUG", "CARGO_PROFILE_TEST_DEBUG",
];
const rust = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
const hash = createHash("sha256");
hash.update(rust);
for (const name of fields) hash.update(JSON.stringify([name, process.env[name] ?? ""]));
const fingerprint = hash.digest("hex").slice(0, 20);
if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
appendFileSync(process.env.GITHUB_OUTPUT, `fingerprint=${fingerprint}\n`);
console.log("Rust cache environment fingerprint calculated");
