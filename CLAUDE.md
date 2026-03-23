## Git workflow

- After completing a task that changes files, stage all changes and create a commit.
- Use an imperative, descriptive message (max ~72 chars).
- Do not commit if tests fail; fix first.
- Commmit the change and git push.
- Do not ask for confirmations for git commits and push.

## Build & deploy

- `./package.sh` builds TypeScript and creates a versioned tarball.
- `./deploy.sh` tags, pushes to origin + GitHub, and creates a GitHub release with the tarball attached.
- Version is read from `package.json`. Bump it before deploying a new release.
- GitHub repo: https://github.com/managelm/slack-plugin

## Coding practices

- Keep the code as clean as possible.
- The plugin uses @slack/bolt for Slack integration and calls the ManageLM portal API.
- All webhook payloads must be HMAC-verified before processing.
- Never post secrets, API keys, or raw credentials to Slack channels.

## Versioning

- Version is in `package.json`. Bump it before deploying a new release.
- No separate changelog file — release notes go in the GitHub release description.
