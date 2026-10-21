// Supplemental tracked-content scanner. CI also runs Gitleaks with its full rule set.
import { execFileSync } from 'node:child_process';
const files = execFileSync('git', ['ls-files', '-z']).toString().split('\0').filter(Boolean);
const rules = [
  /\bmk_[a-zA-Z0-9_-]{20,}\b/g,
  /\b(?:gh[pousr]_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{40,})\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];
let failures = 0;
for (const file of files) {
  const content = execFileSync('git', ['show', `:${file}`], {
    maxBuffer: 20 * 1024 * 1024,
  }).toString();
  if (
    rules.some((rule) => {
      rule.lastIndex = 0;
      return rule.test(content);
    })
  ) {
    console.error(`Potential credential in ${file} (value suppressed)`);
    failures++;
  }
}
if (failures) process.exit(1);
console.log(`Supplemental secret scan passed for ${files.length} tracked files.`);
