# fastmark — a faster marked 18.1.3

`parse(markdown)` returns exactly the HTML marked 18.1.3 renders with its
default options (GFM on, breaks off, pedantic off, async off). It is a
from-scratch reimplementation, written for the make.fun
`markdown-render-speed-02` competition — no marked source is vendored here.

## How it is fast

The design combines the five things the top of the leaderboard does, in one
module:

- **Two-pass.** Pass 1 walks the blocks (cursor-based, first-character
  dispatch) and collects a light tree while gathering every link reference
  definition — definitions may appear after their use, so inline work is
  deferred until pass 1 is done. Pass 2 renders inline content directly
  from that tree, in document order.
- **Plain-text fast path.** An inline source with none of the markup
  triggers (escape, tag, link, code, emphasis, strikethrough, autolink,
  bare URL/e-mail, hard break) is one text run, rendered by a single
  decode/escape pass with no scanner loop. Plain runs inside longer sources
  are copied the same way.
- **Optimised lexer pipeline.** Blocks are recognised by first character,
  so most rules are never tried; headings and thematic breaks are parsed
  with string operations, paragraphs are collected by a line scan instead
  of a lazy backtracking regex, and the mask/closer scan for emphasis is
  built lazily, only when a run actually contains a delimiter.
- **Lean driver.** `main.ts` is a minimal driver: read the cases, call
  `parse()` once per case, write the output. No per-call lexer/parser/
  renderer objects are allocated.
- **Better than each on its own.** There is no token tree at all — marked
  builds block tokens, then inline tokens, then renders; this module
  renders straight from the light block tree, so the two biggest
  allocations in the reference pipeline never happen. No result is cached
  across cases and nothing is written to `/tmp`, so output is
  deterministic: two runs are byte-identical.

## Files

- `parse.js` — the parser/renderer (dependency-free ES module, `parse()`).
- `main.ts` — the harness driver (reads `/input/cases.json`, writes
  `/output/html.json`).
- `LICENSE` — MIT, plus the marked attribution note.

## Verify

Run the kit scorer against this directory (from the kit folder):

```sh
node program/scorer/main.ts --bot <this repo>
```

or run `main.ts` directly with `MAKEFUN_INPUT_DIR` /
`MAKEFUN_OUTPUT_DIR` set to the practice input/output folders.
