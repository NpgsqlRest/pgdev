import { pc } from "./terminal.ts";

export interface Option {
  label: string;
  description: string;
}

export function ask(question: string, options: Option[]): number {
  console.log();
  console.log(`  ${pc.bold(question)}`);
  console.log();

  const maxLabel = Math.max(...options.map((o) => o.label.length));
  for (let i = 0; i < options.length; i++) {
    const num = pc.bold(`${i + 1}.`);
    const label = options[i].label.padEnd(maxLabel);
    console.log(`  ${num} ${label}  ${pc.dim(options[i].description)}`);
  }

  console.log();

  while (true) {
    const input = prompt(pc.dim(">"));
    if (input === null) {
      process.exit(0);
    }
    const n = parseInt(input.trim(), 10);
    if (n >= 1 && n <= options.length) {
      return n - 1;
    }
    console.log(pc.red(`  Please enter a number between 1 and ${options.length}`));
  }
}

export function askConfirm(question: string, defaultYes = false): boolean {
  const hint = defaultYes ? "Y/n" : "y/N";
  const input = prompt(`  ${pc.bold(question)} ${pc.dim(`[${hint}]`)}`);
  const answer = (input ?? "").trim().toLowerCase();
  if (answer === "") return defaultYes;
  return answer === "y" || answer === "yes";
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
