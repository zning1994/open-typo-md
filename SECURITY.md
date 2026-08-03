# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private reporting instead: go to the [Security tab](https://github.com/zning1994/mosu/security)
and choose **Report a vulnerability**. That opens a private thread visible only to
you and the maintainers.

Please include:

- what an attacker can do, and what they need in order to do it;
- the smallest document, file or repro steps that trigger it;
- the version or commit you tested, and your OS.

You will get a first reply within about a week. This is a small project without a
paid security team — if a fix needs more time than that, you will be told where
things stand rather than left waiting.

There is no bug bounty.

## Supported versions

Pre-1.0. Only the latest release gets fixes; there are no maintained release
branches. If a fix matters to you and you are on an older build, upgrade.

## What this project treats as a vulnerability

Mosu opens files that the user did not write. A Markdown document can contain raw
HTML, remote image URLs, `javascript:` links and LaTeX — so **the document itself
is untrusted input**, and anything that lets a document escape the editor is in
scope:

- **Reading or writing files outside what the user opened.** The renderer process
  is not trusted; every path it sends to the main process goes through a whitelist
  (`apps/desktop/src/main/path-guard.ts`). Any way around that wall counts, including
  symlink tricks, `..` traversal, and getting the main process to grant a path the
  user never chose.
- **Code execution from document content** — in the renderer, in the main process,
  or in an exported file. Inline HTML is rendered as class names only; no HTML from
  a document reaches the DOM. Exported HTML is sanitised. Holes in either are in scope.
- **Data loss caused by a crafted document**: silently truncating, corrupting or
  overwriting a user's file.
- **Leaking local file contents or paths** to a remote host, for example through an
  image URL, a stylesheet, or an exported document.
- **Escaping the sandbox of an exported HTML or PDF file** — an export that runs
  script when opened in a browser.

## What is not a vulnerability

- **Unsigned Windows builds triggering SmartScreen.** Known and deliberate; the
  reasoning is in `docs/design/07-quality.md` §6.2.
- **Opening a file the user explicitly chose in a dialog.** That is the product
  working. The whitelist exists to stop paths the user *did not* choose.
- **A document rendering something ugly or wrong.** That is a bug — please open a
  normal issue.
- **Findings from an automated scanner with no working proof of concept.** A CVE
  number in a transitive dependency is not by itself a report; say what an attacker
  can actually do with it here.

## Where the design is written down

If you want to understand the trust boundaries before poking at them:

- `docs/design/01-architecture.md` §5 — process model, what the renderer is allowed
  to ask for, and who is allowed to grant a path.
- `docs/design/06-export.md` §2 — what gets stripped on export and why.
- `apps/desktop/test/path-guard.test.ts` — the whitelist's boundaries, one assertion
  at a time.

These documents are written in Chinese and are not translated. They are worth a
machine translation if you are looking for the sharp edges.
