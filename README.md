# site-generator-speed

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/taamzliketaamz/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/taamzliketaamz/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

An entry for the make.fun bounty **site-generator-speed-01**: a static-site
generator that renders a site of Markdown files through templates and must
produce output byte-for-byte identical to the reference generator — only
faster. The scoring is an exactness gate first (one wrong byte and the run
does not count), then CPU time, lowest wins.

## How it works

`solve.js` exports `run(input)`: given the site's config, its templates and
its Markdown files, it returns the rendered files. The implementation is a
one-pass design — every file is classified once, word counts are fused into
the same line pass that renders Markdown, template renders and slugifying
are memoised per build, and includes are flattened with the reference's
exact depth semantics. `main.ts` is the thin driver the harness calls; it
reads the case from disk and writes the answers out.

## Run it

```
node main.ts
```

The harness provides the case files and the output directory.

---

Made for [make.fun](https://make.fun/bounty/site-generator-speed-01-run-20261122) — [join via my referral](https://make.fun/?ref=dc09wtqt)
