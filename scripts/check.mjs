import { readFile, readdir, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import path from "node:path";
import { root } from "./share.mjs";
async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
}
const files = [
  path.join(root, "server.mjs"),
  ...(await walk(path.join(root, "public"))),
  ...(await walk(path.join(root, "scripts"))),
  ...(await walk(path.join(root, "test"))),
];
for (const file of files) {
  assert.ok(
    !/\.(z64|v64|n64|sav|state|smash64)$/i.test(file),
    "Game data found in distributable source",
  );
  if (/\.(mjs|js)$/.test(file))
    execFileSync(process.execPath, ["--check", file]);
}
const manifest = JSON.parse(
  await readFile(path.join(root, "public/source/manifest.json"), "utf8"),
);
for (const [name, entry] of Object.entries(manifest.files)) {
  const data = await readFile(path.join(root, "public", name));
  assert.equal(createHash("sha256").update(data).digest("hex"), entry.sha256);
  assert.equal(data.length, entry.bytes);
}
const html = await readFile(path.join(root, "public/index.html"), "utf8");
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
assert.equal(
  new Set(ids).size,
  ids.length,
  "Duplicate application element IDs",
);
const app = await readFile(path.join(root, "public/js/app.js"), "utf8");
for (const match of app.matchAll(/\$\(["']([a-z][\w-]*)["']\)/g))
  assert.ok(ids.includes(match[1]), `Missing UI element: ${match[1]}`);
for (const match of html.matchAll(/(?:src|href)="(\/[^"#]*)"/g)) {
  if (match[1] === "/") continue;
  await stat(path.join(root, "public", match[1]));
}
console.log(
  "Syntax, engine checksums, linked assets, and ROM-exclusion checks passed.",
);
