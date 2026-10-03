# actions-runner — this Mac as the iOS build machine

A GitHub Actions self-hosted runner that runs `.github/workflows/ship-preview.yml`, which runs
`pnpm ship:preview` in `apps/mobile`. Only `runner.sh`, `hooks/` and these two files are committed.
Everything else in this folder is created by the runner and is gitignored.

```bash
actions-runner/runner.sh install <registration-token>   # once; token from Settings → Actions → Runners
actions-runner/runner.sh status | logs | restart
actions-runner/runner.sh env && actions-runner/runner.sh restart   # after changing node/pnpm/Xcode
```

`hooks/job-started.sh` is the guard for a public repo: the runner refuses every job that isn't
`ship-preview.yml` on `master`, started by an allow-listed account.

Full design, setup and security notes: `docs/2026-10-03-remote-triggers-for-local-ios-build.md`.
