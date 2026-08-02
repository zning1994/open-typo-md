---
layout: home

hero:
  name: "Brainforge Typo"
  text: "What you type is what you see"
  tagline: "An open-source WYSIWYG Markdown editor. No split pane, no preview pane — just one editing surface."
  actions:
    - theme: brand
      text: "GitHub"
      link: https://github.com/zning1994/open-typo-md
    - theme: alt
      text: "Download"
      link: https://github.com/zning1994/open-typo-md/releases
    - theme: alt
      text: "Design docs (Chinese)"
      link: /design/00-overview

features:
  - title: Source first, zero-loss round trip
    details: "The editor buffer holds exactly the Markdown that is on disk — no private intermediate model. Open a file and save it, and it comes back byte for byte: encoding, line endings, and whether you wrote * or _."
  - title: Markers appear only where the cursor is
    details: "Headings, bold text, links and images are shown in their final form. Move the cursor into an element and its Markdown markers reappear in place, ready to edit. CJK input methods work inside decorated regions — there is a regression suite guarding that."
  - title: Local first, no lock-in
    details: "A workspace is just a folder. No account, no sync service. Settings live in a plain JSON file that you are meant to open and edit."
  - title: The core does not depend on Electron
    details: "The editor core is a plain web library that imports no Node or Electron API; host capabilities are injected. A browser or any other shell can reuse it as is."
---

<div class="shot shot-light"><img src="/shots/en/hero-light.png" alt="Brainforge Typo editing a document with a table, task list and math" /></div>
<div class="shot shot-dark"><img src="/shots/en/hero-dark.png" alt="Brainforge Typo in its dark theme" /></div>

<p class="shot-caption">These screenshots are taken by a script driving the real app
(<code>pnpm screenshots</code>), not mockups — the column widths, the typeset formula and the
diagram below are all computed by the product itself.</p>

## Markers appear only when the cursor arrives

This is the whole interaction, and it is what separates the editor from "source on the left,
preview on the right": normally you see typeset text; move the cursor in, and the Markdown
markers for that one element appear in place so you can edit them.
**No mode switch, no second pane.**

<div class="shot-pair">
  <div>
    <div class="shot"><img src="/shots/en/reveal-before.png" alt="With the cursor elsewhere, bold text shows only its formatting" /></div>
    <p class="shot-caption">Cursor outside — formatting only</p>
  </div>
  <div>
    <div class="shot"><img src="/shots/en/reveal-after.png" alt="With the cursor inside, the asterisks around the bold text appear" /></div>
    <p class="shot-caption">Cursor inside — the <code>**</code> come back</p>
  </div>
</div>

## Code, math and diagrams live in the same surface

Code blocks are highlighted per language and do not wrap along with prose; math goes through
KaTeX; a ` ```mermaid ` fence renders straight to a diagram. All of it is lazy-loaded — a
document that uses none of these pays no startup cost for them.

<div class="shot"><img src="/shots/en/blocks-light.png" alt="A TypeScript code block with syntax highlighting above a mermaid flow chart" /></div>

## Where the project stands

**Usable, but not formally released yet.** Version 0.1.0. The most recent batch of work
(milestone "M4.5") is done:

GFM (tables, task lists, strikethrough, footnotes), math, Mermaid diagrams, an outline panel,
a command palette, crash recovery, six themes, HTML and PDF export, copy-as-rich-text,
paste-HTML-as-Markdown, table editing, a file tree, tabs, session restore, a settings panel,
inline HTML rendering, customisable shortcuts, focus mode, typewriter mode and a
Chinese/English/Japanese interface are all working.

**Not there yet:** the plugin system, user theme directories with hot reload, block-level HTML
rendering, drag-to-resize table columns, PDF headers/footers and TOC page numbers, and
rename/create/delete in the file tree.

Every milestone ends with a "what actually differed from the plan" section listing exactly what
was cut and why. That list is part of the project, not an embarrassment to hide.

## Trying it

There is no tagged release yet, but every push to `main` produces installers for all three
platforms under
[Actions](https://github.com/zning1994/open-typo-md/actions).

⚠️ **Those builds are unsigned.** macOS will refuse them on first launch (right-click → Open, or
allow them under System Settings → Privacy & Security) and Windows SmartScreen will warn. This is
not a problem with the app — the signing certificates simply are not configured yet.

Running from source is easier:

```bash
pnpm install
pnpm dev
```

## A note on the documentation

**The design documents are written in Chinese and are not translated.** That is a deliberate
trade-off rather than unfinished work: there are nine design documents plus five architecture
decision records, they change as development goes on, and translating a moving target costs not
one translation but one per revision, forever.

They are worth a machine translation if you are curious, because they are not feature lists —
they record **trade-offs and mistakes**:

- [Why CodeMirror 6 and not ProseMirror](/adr/0002-editor-core) — a rich-text editor's document
  model inherently requires an intermediate representation, which is exactly what conflicts with
  "the source is the truth";
- [Why two Markdown parsers](/adr/0003-dual-parser) — editing needs incremental, position-exact
  parsing; export needs full semantics. One parser doing both does neither well;
- [Chasing a blank-page PDF bug on macOS through seven CI rounds](/design/06-export) — six
  conclusions proposed and disproved before measuring the variable space found a single font at
  fault;
- [Rendering HTML in a document without parsing HTML](/design/02-editor-core) — sidestepping the
  sanitiser entirely, because one gap in a sanitiser inside Electron is XSS escalating to RCE.

## Relationship to Typora

The commercial product with a comparable experience is [Typora](https://typora.io/). This project
is an **independent implementation**: it reuses none of its code, assets or interface materials,
and borrows only the seamless live-preview interaction model. The two are not affiliated.
