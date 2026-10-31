# Release runbook

## Before a release

- Review the changelog and confirm the target version.
- Run type-checking and the full test suite.
- Inspect the generated package contents before publishing.

## Deployment verification

- Deploy to the staging environment first.
- Confirm health checks and error rates remain normal.
- If verification fails, stop the rollout and follow the incident process.

## Recovery

- Record the release version and observed symptoms.
- Prefer a documented rollback over an unreviewed hotfix.
- Verify service health after rollback.
