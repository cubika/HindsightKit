# Security policy

## Supported versions

Security fixes are provided for the latest published `0.1.0-alpha` release.
Pre-release support may require upgrading to the newest Alpha before a fix can
be applied.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or include secrets,
session files, queue files, prompts, tool results, or local databases in a
report.

Use the repository's **Security** tab to submit a private vulnerability report
through GitHub Security Advisories. Include the affected version, operating
system, reproduction steps, impact, and the smallest privacy-safe diagnostic
output needed to investigate.

## Sensitive local data

Never attach these files to an issue or vulnerability report:

- `%LOCALAPPDATA%\ProvenLoop\data\provenloop.db`;
- `%LOCALAPPDATA%\ProvenLoop\backends\knowledge.db`;
- raw queue or Copilot Session files;
- Copilot settings, credentials, prompts, tool arguments, or tool results.

Share only generated acceptance reports after reviewing them for unexpected
content.
