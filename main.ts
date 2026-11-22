// Entry driver for site-generator-speed-01: the harness runs `node /bot/main.ts` (node22). It reads every case from
// /input/cases.json (a JSON array of {id, input}), answers each case on its own with run() from solve.js, and writes
// /output/answers.json: a JSON array of the answers, one per case and in the cases' order. Outside a container,
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// Turn V8's incremental marking off before solve.js is imported, so all of its work runs under the same flag the
// house baseline is timed with (the rules allow an entry to tune V8's flags the same way). The optimising compiler
// goes off too: a grading run is a single cold pass in a fresh process, where that compiler's work costs more than
// it returns, while the mid-tier compiler carries the pass at full speed.
setFlagsFromString('--no-incremental-marking');
setFlagsFromString('--no-opt');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
