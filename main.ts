// Harness driver for the markdown-render-speed-02 entry.
//
// The grader mounts the case set at /input and expects the rendered
// results at /output. This driver stays deliberately thin: it loads
// the cases, hands each Markdown source to parse() in order, and
// serialises the HTML strings it gets back. All of the rendering
// work (and all of the speed) lives in parse.js next to this file.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parse } from "./parse.js";

const INPUT_PATH = "/input/cases.json";
const OUTPUT_PATH = "/output/html.json";

// The cases file is a JSON array of {"id", "markdown"} objects.
// Order matters: the output array must line up case for case.
const raw = readFileSync(INPUT_PATH, "utf8");
const cases = JSON.parse(raw);

// Render every case, keeping the results in the same order.
const html = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

// /output is a mount point in the sandbox, so it is created in
// place when missing and never removed.
mkdirSync("/output", { recursive: true });
writeFileSync(OUTPUT_PATH, JSON.stringify(html));
