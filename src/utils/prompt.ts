import { readSync } from "node:fs";
import { pc } from "./terminal.ts";

export interface Option {
  label: string;
  description: string;
  help?: string;
}

/**
 * Read a single keypress from stdin using a direct fd read.
 * Bypasses the Node.js stream API entirely — immune to stale listeners
 * or dirty stream state left by subprocess operations (Bun shell, Bun.spawn).
 * Must be called while stdin is in raw mode.
 */
function readKey(): string {
  const buf = Buffer.alloc(32);
  const n = readSync(0, buf, 0, 32, null);
  return buf.subarray(0, n).toString();
}

function truncate(s: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

function renderOptions(options: Option[], selected: number, hint: string, helpHeight: number): void {
  const cols = process.stdout.columns || 80;
  const maxLabel = Math.max(...options.map((o) => o.label.length));
  const maxNumWidth = `${options.length}.`.length;
  // Line format: "  > N. label  description" — prefix takes 5 + numWidth + maxLabel + 2
  const descAvail = cols - 5 - maxNumWidth - maxLabel - 2;

  for (let i = 0; i < options.length; i++) {
    const isSelected = i === selected;
    const num = `${i + 1}.`.padStart(maxNumWidth);
    const label = options[i].label.padEnd(maxLabel);
    const desc = truncate(options[i].description, descAvail);
    if (isSelected) {
      process.stdout.write(`  ${pc.cyan(">")} ${pc.cyan(num)} ${pc.bold(label)}  ${pc.dim(desc)}\n`);
    } else {
      process.stdout.write(`    ${pc.dim(num)} ${label}  ${pc.dim(desc)}\n`);
    }
  }
  process.stdout.write(`\n  ${pc.dim(hint)}\n`);

  if (helpHeight > 0) {
    const helpAvail = cols - 2;
    const helpLines = options[selected].help?.split("\n") ?? [];
    process.stdout.write("\n");
    for (let i = 0; i < helpHeight; i++) {
      if (i < helpLines.length) {
        process.stdout.write(`  ${pc.dim(truncate(helpLines[i], helpAvail))}\n`);
      } else {
        process.stdout.write(`\x1B[2K\n`);
      }
    }
  }
}

function clearLines(count: number): void {
  process.stdout.write(`\x1B[${count}A`);
  for (let i = 0; i < count; i++) {
    process.stdout.write(`\r\x1B[2K\n`);
  }
  process.stdout.write(`\x1B[${count}A`);
}

function askFallback(question: string, allOptions: Option[], exitIndex: number): number {
  console.log();
  console.log(`  ${pc.bold(question)}`);
  console.log();

  const maxLabel = Math.max(...allOptions.map((o) => o.label.length));
  for (let i = 0; i < allOptions.length; i++) {
    const num = pc.bold(`${i + 1}.`);
    const label = allOptions[i].label.padEnd(maxLabel);
    console.log(`  ${num} ${label}  ${pc.dim(allOptions[i].description)}`);
  }

  console.log();

  while (true) {
    const input = prompt(pc.dim(">"));
    if (input === null) {
      process.exit(0);
    }
    const n = parseInt(input.trim(), 10);
    if (n >= 1 && n <= allOptions.length) {
      return n - 1 === exitIndex ? -1 : n - 1;
    }
    console.log(pc.red(`  Please enter a number between 1 and ${allOptions.length}`));
  }
}

export async function ask(
  question: string,
  options: Option[],
  opts: { exit?: boolean } = {},
): Promise<number> {
  const isExit = opts.exit === true;
  const allOptions = [
    ...options,
    { label: isExit ? "Exit" : "Back", description: isExit ? "" : "Return to previous menu" },
  ];
  const exitIndex = options.length;
  const backHint = isExit ? "Backspace to exit" : "Backspace to go back";
  const hint = `Enter to select · ${backHint}`;

  if (!process.stdin.isTTY) {
    return askFallback(question, allOptions, exitIndex);
  }

  // Fixed-height help area: sized to the tallest help text across all options
  const maxHelpLines = Math.max(0, ...allOptions.map((o) => (o.help ? o.help.split("\n").length : 0)));
  // helpHeight = max help lines; helpAreaHeight includes the blank separator line
  const helpAreaHeight = maxHelpLines > 0 ? 1 + maxHelpLines : 0;
  const totalHeight = allOptions.length + 2 + helpAreaHeight;

  console.log();
  console.log(`  ${pc.bold(question)}`);
  console.log();

  let selected = 0;
  renderOptions(allOptions, selected, hint, maxHelpLines);

  process.stdin.setRawMode(true);
  try {
    while (true) {
      const key = readKey();

      if (key === "\x1B[A" || key === "\x1BOA") {
        // Arrow up (normal mode or application mode)
        if (selected > 0) {
          selected--;
          clearLines(totalHeight);
          renderOptions(allOptions, selected, hint, maxHelpLines);
        }
      } else if (key === "\x1B[B" || key === "\x1BOB") {
        // Arrow down (normal mode or application mode)
        if (selected < allOptions.length - 1) {
          selected++;
          clearLines(totalHeight);
          renderOptions(allOptions, selected, hint, maxHelpLines);
        }
      } else if (key === "\r" || key === "\n") {
        // Enter — select current
        if (selected === exitIndex) return -1;
        return selected;
      } else if (key === "\x7F" || key === "\x08") {
        // Backspace — back/exit
        return -1;
      } else if (key === "\x03") {
        // Ctrl+C
        process.exit(0);
      } else {
        // Number key
        const n = parseInt(key, 10);
        if (n >= 1 && n <= allOptions.length) {
          if (n - 1 === exitIndex) return -1;
          clearLines(totalHeight);
          renderOptions(allOptions, n - 1, hint, maxHelpLines);
          return n - 1;
        }
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    // Clean up the help area so caller output appears right after the hint
    if (helpAreaHeight > 0) {
      process.stdout.write(`\x1B[${helpAreaHeight}A\x1B[J`);
    }
  }
}

export function askConfirm(question: string, defaultYes = false): boolean {
  const hint = defaultYes ? "Y/n" : "y/N";
  const input = prompt(`  ${pc.bold(question)} ${pc.dim(`[${hint}]`)}`);
  const answer = (input ?? "").trim().toLowerCase();
  if (answer === "") return defaultYes;
  return answer === "y" || answer === "yes";
}

export function askValue(
  label: string,
  currentValue: string,
  options?: { mask?: boolean },
): string {
  const isPlaceholder = /^\{.+\}$/.test(currentValue);
  const display = options?.mask && currentValue && !isPlaceholder ? "****" : currentValue;
  const input = prompt(`  ${label.padEnd(12)} ${pc.dim(`[${display}]`)}>`);
  return (input ?? "").trim() || currentValue;
}

export function askPath(question: string, defaultPath: string): string {
  console.log();
  console.log(`  ${pc.bold(question)}`);
  const input = prompt(pc.dim(`  [${defaultPath}]>`));
  if (input === null) {
    process.exit(0);
  }
  const value = input.trim() || defaultPath;
  return value.replace(/\/+$/, "") || ".";
}
