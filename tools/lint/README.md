# Quality tooling

The Bun gateway retains the measured Ubiquity TypeScript ruleset and pinned tooling versions in this directory.
Application dependencies, Bun typings and strict TypeScript configuration live at the repository root; ESLint's
`tsconfig.lint.json` extends that same project without generated runtime declarations.

| Path                                     | Purpose                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| Root `package.json` and `bun.lock`       | Application graph, Bun 1.4.0 pin and public scripts                      |
| `tools/lint/package.json` and `bun.lock` | Frozen ESLint, typescript-eslint, SonarJS, Knip and Prettier graph       |
| `tools/lint/eslint.config.mjs`           | Existing typed rules, measured exceptions and browser JavaScript checks  |
| `tsconfig.lint.json`                     | Same Bun/Node/Web types and strict compiler options as `tsconfig.json`   |
| `.prettierrc` and `.prettierignore`      | One formatter owner; TypeScript 160 columns, other supported formats 120 |
| `knip.json`                              | Real first-party entry points and documented dynamic-import exceptions   |
| `scripts/file-size-ratchet.ts`           | Tightening-only 1000-line source and 1500-line test ceilings             |
| `scripts/test-runner.ts`                 | Fresh Bun process per test file and explicit environment profiles        |

Install root dependencies with `bun install --frozen-lockfile`, then run the wrappers. Both lockfiles must exist: Bun's
frozen option alone does not refuse a missing lockfile. The bootstrap checks Bun 1.4.0, installs only the frozen quality
graph, and may reuse another worktree's tooling only when its package and lock are byte-identical. It never falls back
to another package manager or upgrades the host.

```sh
sh scripts/verify.sh
sh scripts/lint.sh scripts/test-runner.ts
sh scripts/format.sh --check scripts/test-runner.ts
sh scripts/knip.sh
bun --no-env-file scripts/test-runner.ts main
```

`verify.sh` runs all quality checks and every former deployment, immutable-release, main, OSS, measurement, hook, Mac
and Sentinel test segment, collecting all failures. The ordinary `test` task still includes its special subsegments.
Stress, live e2e and benchmark commands remain separately selected. Every test file gets a fresh process; serial test
concurrency alone is not module-state isolation. Child processes disable dotenv discovery and inherit only transport
necessities and the segment's named inputs. `UOS_TEST_PROFILE` identifies the fixture segment; it grants no permission
or credential. Fixture network controls and operating-system service confinement are distinct acceptance surfaces.

Prettier owns every supported first-party file type. Existing source rules and measured exceptions remain in place; this
migration does not authorize a whole-repository autofix, an increased file-size ceiling, or ignored dead-code findings.
`size:update` only tightens or drops existing ceilings. Knip retains entry points, dynamic-import exceptions and
dependency visibility through the root package graph.

The historical Deno checker/type-environment measurements remain in the ESLint comments as provenance. Strict root
TypeScript checking and migrated tests now decide whether an autofix is correct; a successful transpile or a reduced
lint count is insufficient. Complete verification is run on the settled canonical candidate, after all writers stop.
