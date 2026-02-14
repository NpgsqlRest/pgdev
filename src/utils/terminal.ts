import pc from "picocolors";

export { pc };

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL = 80;

export interface Spinner {
  stop(finalText?: string): void;
  update(text: string): void;
}

export function spinner(text: string): Spinner {
  let frameIndex = 0;
  let currentText = text;

  const clearLine = () => {
    process.stderr.write("\r\x1b[K");
  };

  const render = () => {
    clearLine();
    process.stderr.write(`${pc.cyan(SPINNER_FRAMES[frameIndex])} ${currentText}`);
    frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
  };

  render();
  const interval = setInterval(render, SPINNER_INTERVAL);

  return {
    stop(finalText?: string) {
      clearInterval(interval);
      clearLine();
      if (finalText) {
        process.stderr.write(`${finalText}\n`);
      }
    },
    update(newText: string) {
      currentText = newText;
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
