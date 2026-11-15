/** Run after production build. Do not print or read any secret file contents. */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

for (const route of ["scan", "scans/[id]/artifacts/[artifactId]", "auth/login", "auth/logout"]) {
  const manifest = `.next/server/app/api/${route}/route.js.nft.json`;
  const files = JSON.parse(await readFile(manifest, "utf8")).files;
  const privatePaths = files.filter((file) => {
    const name = path.basename(file);
    return name === ".env" || name.startsWith(".env.") && name !== ".env.example" || name === ".git" || file.includes("/.git/");
  });
  assert.equal(privatePaths.length, 0, `${route} must not trace private environment/account/Git files`);
  console.log(`PASS ${route}: ${files.length} runtime references; no private environment/account/Git files`);
}

if (process.argv.includes("--check-client-env")) {
  // Supply .env through Node's --env-file flag; never print the values or read the credential file here.
  const names = ["VERIPAGE_AGNES_API_KEY", "VERIPAGE_SESSION_SECRET", "VERIPAGE_REVIEWER_PASSWORD_HASH"];
  const secrets = names.map((name) => {
    const value = process.env[name];
    assert.ok(value, `${name} must be configured for a meaningful client-bundle check`);
    return { name, value };
  });
  let checked = 0;
  const directories = [".next/static"];
  while (directories.length) {
    const directory = directories.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) directories.push(file);
      else if (entry.isFile() && file.endsWith(".js")) {
        const contents = await readFile(file, "utf8");
        for (const { name, value } of secrets) assert.ok(!contents.includes(value), `${name} must not be embedded in public JavaScript (${file})`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 0, "Production JavaScript must exist");
  console.log(`PASS ${checked} public JavaScript files contain no literal configured model key, session secret or password hash`);
}
