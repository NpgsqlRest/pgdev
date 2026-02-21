import pc from "picocolors";

export { pc };

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL = 80;

export interface Spinner {
  stop(finalText?: string): void;
  update(text: string): void;
  pause(): void;
  resume(): void;
}

export function spinner(text: string): Spinner {
  let frameIndex = 0;
  let currentText = text;
  let intervalId: ReturnType<typeof setInterval> | null;

  const clearLine = () => {
    process.stderr.write("\r\x1b[K");
  };

  const render = () => {
    clearLine();
    process.stderr.write(`${pc.cyan(SPINNER_FRAMES[frameIndex])} ${currentText}`);
    frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
  };

  render();
  intervalId = setInterval(render, SPINNER_INTERVAL);

  return {
    stop(finalText?: string) {
      if (intervalId) clearInterval(intervalId);
      intervalId = null;
      clearLine();
      if (finalText) {
        process.stderr.write(`${finalText}\n`);
      }
    },
    update(newText: string) {
      currentText = newText;
    },
    pause() {
      if (intervalId) clearInterval(intervalId);
      intervalId = null;
      clearLine();
    },
    resume() {
      render();
      intervalId = setInterval(render, SPINNER_INTERVAL);
    },
  };
}

export function success(text: string): string {
  return `${pc.green("✓")} ${text}`;
}

export function error(text: string): string {
  return `${pc.red("✗")} ${text}`;
}

export function info(text: string): string {
  return `${pc.blue("ℹ")} ${text}`;
}

function shellQuote(args: string[]): string {
  return args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ");
}

export function formatCmd(cmd: string[]): string {
  return `$ ${shellQuote(cmd)}`;
}

export function logCommand(cmd: string[]): void {
  console.error(`\n${pc.cyan("$")} ${shellQuote(cmd)}`);
}

export function logOutput(output: string): void {
  if (!output) return;
  for (const line of output.split("\n")) {
    console.error(pc.dim(`    ${line}`));
  }
}
