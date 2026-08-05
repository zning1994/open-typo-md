# Contributing to Mosu

Thanks for taking a look. This file covers what you need to build the project and
what a change is expected to come with.

## Getting it running

Node ≥ 20.19 and pnpm.

```bash
pnpm install
pnpm dev          # renderer has HMR; main/preload restart on change
```

```bash
pnpm verify       # what CI runs: layering + types + lint + format + unit tests
pnpm test         # unit tests only (includes the full CommonMark corpus)
pnpm test:e2e     # end-to-end, real Electron + real Chromium
pnpm build        # build main / preload / renderer
```

On Linux the end-to-end tests need a display: `xvfb-run -a pnpm test:e2e`.

**Run `pnpm verify` before opening a pull request.** It is the same command the
release pipeline runs, on all three platforms.

## Read this one document first

If you are touching the editor, read
[02 · Editor core](docs/design/02-editor-core.md) before writing code. The
decoration rules are the easiest thing in this project to break, and that document
explains why each one looks the way it does.

**The design documents are in Chinese and are not translated.** That is a deliberate
trade-off, not neglect: there are ten of them plus six architecture decision
records, and they change as development goes on — translating a moving target costs
one translation per revision, forever. They are worth a machine translation, because
they record trade-offs and mistakes rather than feature lists.

## Three rules the code has to hold

These are not style preferences. Breaking any of them is a correctness bug.

1. **The file is the truth.** The CodeMirror buffer holds exactly the Markdown on
   disk. Rendering is a decoration-based projection over that buffer — there is no
   private intermediate model. A change that makes open-then-save produce different
   bytes is a bug, however nice it looks.
2. **Never swallow content.** If the editor cannot make sense of something, it shows
   it as source. It does not drop it.
3. **The editor core knows nothing about Node or Electron.** `packages/editor` and
   everything below it must stay usable in a plain browser. `pnpm layers` enforces
   the dependency direction in CI.

## What a change should come with

- **Tests.** New behaviour gets a test; a bug fix gets a test that fails without the
  fix. Please actually check that it fails — a test that cannot fail is worse than no
  test, because it occupies the space where a real one would go.
- **A note on format fidelity** if you touched decoration rules, the Markdown codec,
  or anything in `packages/markdown`.
- **Comments that explain why**, not what. This codebase leans heavily on comments
  that record the reasoning and the dead ends — if you worked something out the hard
  way, write it down where the next person will hit it.

Unit tests live next to what they test (`packages/*/test/`, `apps/*/test/`);
repository-wide conventions live in `test/`. End-to-end specs are in `e2e/`.

## Platform differences bite here

Unit tests run on Linux for the fast feedback loop, and `verify-cross` re-runs the
same `pnpm verify` on macOS and Windows. If you write a test that touches the real
filesystem, be aware that **a test can pass on Linux while silently checking the
wrong thing** — macOS resolves `/var` through a symlink and Windows has no `/etc`.
Both have caused false-green tests here. `docs/design/07-quality.md` §1 has the
specifics, including how to reproduce macOS's behaviour locally.

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`,
  `docs:`, `ci:`, `test:`, `chore:`, optionally scoped (`fix(test): …`).
- Say what changed, how you tested it, and whether format fidelity is affected.
- New dependencies need a reason and an MIT-compatible licence.

Pull requests only run the heavy pipeline when they touch code. Documentation and
Markdown changes go through a shorter one instead — that is deliberate, not an
oversight.

## Reporting things

- **Bugs and feature requests**: [open an issue](https://github.com/zning1994/mosu/issues).
  There are templates; they exist because the first question is always "which
  platform, which version, and what does the document look like".
- **Security problems**: do not open a public issue. See [SECURITY.md](SECURITY.md).

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
