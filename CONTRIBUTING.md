# Contributing to GoodWe Home

Thank you for improving GoodWe Home. Contributions are welcome for supported inverter data, reliability, accessibility, tests, documentation, and interface quality.

## Before you start

- Keep all inverter interaction read-only. Changes that write settings or operating parameters are out of scope.
- Open an issue before beginning a large behavioral or architectural change.
- Never include real inverter addresses, serial numbers, credentials, or household telemetry in code, screenshots, logs, or fixtures.
- Search existing issues and pull requests to avoid duplicate work.

## Local setup

You need Python 3.11 or newer and Node.js 22.13 or newer.

```bash
git clone https://github.com/AbdullahSaad5/goodwe-home-dashboard.git
cd goodwe-home-dashboard
./setup.sh
```

Run the production-style application with `./start.sh`. For frontend development, run the API and Vite in separate terminals:

```bash
.venv/bin/uvicorn goodwe_home.main:app --host 0.0.0.0 --port 8080
npm run dev
```

## Repository layout

- `server/src/goodwe_home/` contains the Python package and read-only FastAPI service.
- `server/tests/` contains backend tests.
- `web/src/` contains the React application and frontend tests.
- `docs/` contains architecture and project documentation.
- `data/` and `web/dist/` are generated locally and excluded from Git.

See [docs/architecture.md](docs/architecture.md) for module boundaries and data flow.

## Quality checks

Run the same checks as continuous integration before opening a pull request:

```bash
make format
make lint
make test
make build
```

Add focused tests for new behavior and regressions. Avoid unrelated formatting or refactors in a feature pull request.

## Pull requests

1. Create a focused branch from `main`.
2. Make one coherent change and update relevant documentation.
3. Confirm the read-only invariant and privacy checklist in the pull request template.
4. Explain the user-facing behavior and the checks you ran.
5. Respond to review feedback with additional commits; maintainers may squash when merging.

By contributing, you agree that your contribution is licensed under the project's MIT License and that you will follow the [Code of Conduct](CODE_OF_CONDUCT.md).
