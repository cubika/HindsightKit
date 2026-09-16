# Release evidence

The `0.1.0-alpha.0.x` line is the explicit evidence-collection candidate and
is exempt from retained M0/MVP evidence. Before tagging an evidence-approved
release such as `0.1.0-alpha.1`, add a privacy-reviewed directory named for the
package version:

```text
release-evidence/
  0.1.0-alpha.1/
    m0-evidence.json
    release-evidence.json
    m0-report.json
    mvp-report.json
    release-notes.md
```

Only generated reports and version-bound evidence belong here. Never commit
databases, raw queue files, Session files, prompts, code, tool arguments, tool
results, settings, or credentials.
