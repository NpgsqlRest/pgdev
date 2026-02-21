import { readSync, readdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
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
  options?: { mask?: boolean; path?: boolean },
): string {
  const isPlaceholder = /^\{.+\}$/.test(currentValue);
  const display = options?.mask && currentValue && !isPlaceholder ? "****" : currentValue;
  if (options?.path) {
    const promptStr = `  ${label.padEnd(12)} ${pc.dim(`[${display}]`)}> `;
    const input = readLineRaw(promptStr, fileComplete);
    return (input ?? "").trim() || currentValue;
  }
  const input = prompt(`  ${label.padEnd(12)} ${pc.dim(`[${display}]`)}>`);
  return (input ?? "").trim() || currentValue;
}

// --- Dashboard ---

export interface DashboardSection {
  title: string;
  items: DashboardItem[];
}

export interface DashboardItem {
  key: string;
  label: string;
  value: string;
  help?: string;
}

export interface DashboardAction {
  key: string;
  label: string;
}

export type DashboardResult =
  | { type: "item"; key: string }
  | { type: "action"; key: string };

function renderDashboard(
  sections: DashboardSection[],
  actions: DashboardAction[],
  allItems: DashboardItem[],
  selected: number,
  maxHelpLines: number,
  statusLines: string[],
): void {
  const cols = process.stdout.columns || 80;
  const maxLabel = Math.max(...allItems.map((i) => i.label.length));
  const maxNumWidth = `${allItems.length}.`.length;
  const valueAvail = cols - 5 - maxNumWidth - maxLabel - 2;
  const dividerWidth = Math.min(cols - 4, 50);
  const divider = pc.dim("─".repeat(dividerWidth));

  let itemIndex = 0;
  for (let s = 0; s < sections.length; s++) {
    if (s > 0) process.stdout.write("\n");
    if (sections[s].title) {
      process.stdout.write(`  ${pc.bold(sections[s].title)}\n`);
      process.stdout.write(`  ${divider}\n`);
    }

    for (const item of sections[s].items) {
      const isSelected = itemIndex === selected;
      const num = `${itemIndex + 1}.`.padStart(maxNumWidth);
      const label = item.label.padEnd(maxLabel);
      const value = truncate(item.value, valueAvail);
      if (isSelected) {
        process.stdout.write(`  ${pc.cyan(">")} ${pc.cyan(num)} ${pc.bold(label)}  ${pc.dim(value)}\n`);
      } else {
        process.stdout.write(`    ${pc.dim(num)} ${label}  ${pc.dim(value)}\n`);
      }
      itemIndex++;
    }
  }

  process.stdout.write("\n");
  process.stdout.write(`  ${divider}\n`);
  for (const action of actions) {
    process.stdout.write(`   ${pc.cyan(action.key)}  ${action.label}\n`);
  }

  if (maxHelpLines > 0) {
    process.stdout.write("\n");
    process.stdout.write(`  ${divider}\n`);
    const helpLines = allItems[selected]?.help?.split("\n") ?? [];
    for (let i = 0; i < maxHelpLines; i++) {
      if (i < helpLines.length) {
        process.stdout.write(`  ${pc.dim(truncate(helpLines[i], cols - 2))}\n`);
      } else {
        process.stdout.write(`\x1B[2K\n`);
      }
    }
  }

  if (statusLines.length > 0) {
    process.stdout.write("\n");
    for (const line of statusLines) {
      process.stdout.write(`  ${line}\n`);
    }
  }
}

function getDashboardHeight(sections: DashboardSection[], actions: DashboardAction[], maxHelpLines: number, statusLineCount: number): number {
  let height = 0;
  for (let s = 0; s < sections.length; s++) {
    if (s > 0) height++;
    if (sections[s].title) height += 2;
    height += sections[s].items.length;
  }
  height += 2;
  height += actions.length;
  if (maxHelpLines > 0) {
    height += 2;
    height += maxHelpLines;
  }
  if (statusLineCount > 0) {
    height += 1 + statusLineCount;
  }
  return height;
}

export async function askDashboard(
  title: string,
  sections: DashboardSection[],
  actions: DashboardAction[],
  opts?: { selected?: string; status?: string },
): Promise<DashboardResult | null> {
  const allItems = sections.flatMap((s) => s.items);
  if (allItems.length === 0) return null;

  const actionKeys = new Map(actions.map((a) => [a.key.toLowerCase(), a.key]));
  const maxHelpLines = Math.max(0, ...allItems.map((i) => (i.help ? i.help.split("\n").length : 0)));
  const statusLines = opts?.status ? opts.status.split("\n") : [];
  const bodyHeight = getDashboardHeight(sections, actions, maxHelpLines, statusLines.length);
  const titleHeight = 3;
  const totalHeight = titleHeight + bodyHeight;

  let selected = 0;
  if (opts?.selected) {
    const idx = allItems.findIndex((i) => i.key === opts.selected);
    if (idx >= 0) selected = idx;
  }

  console.log();
  console.log(`  ${pc.bold(title)}`);
  console.log();

  renderDashboard(sections, actions, allItems, selected, maxHelpLines, statusLines);

  if (!process.stdin.isTTY) {
    while (true) {
      const input = prompt(pc.dim(">"));
      if (input === null) return null;
      const trimmed = input.trim().toLowerCase();
      if (actionKeys.has(trimmed)) return { type: "action", key: actionKeys.get(trimmed)! };
      const n = parseInt(trimmed, 10);
      if (n >= 1 && n <= allItems.length) return { type: "item", key: allItems[n - 1].key };
    }
  }

  process.stdin.setRawMode(true);
  try {
    while (true) {
      const key = readKey();

      if (key === "\x1B[A" || key === "\x1BOA") {
        if (selected > 0) {
          selected--;
          clearLines(bodyHeight);
          renderDashboard(sections, actions, allItems, selected, maxHelpLines, statusLines);
        }
      } else if (key === "\x1B[B" || key === "\x1BOB") {
        if (selected < allItems.length - 1) {
          selected++;
          clearLines(bodyHeight);
          renderDashboard(sections, actions, allItems, selected, maxHelpLines, statusLines);
        }
      } else if (key === "\r" || key === "\n") {
        return { type: "item", key: allItems[selected].key };
      } else if (key === "\x1B" || key === "\x7F" || key === "\x08") {
        return null;
      } else if (key === "\x03") {
        process.exit(0);
      } else {
        const lower = key.toLowerCase();
        if (actionKeys.has(lower)) {
          return { type: "action", key: actionKeys.get(lower)! };
        }
        const n = parseInt(key, 10);
        if (n >= 1 && n <= allItems.length) {
          selected = n - 1;
          clearLines(bodyHeight);
          renderDashboard(sections, actions, allItems, selected, maxHelpLines, statusLines);
          return { type: "item", key: allItems[n - 1].key };
        }
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    clearLines(totalHeight);
  }
}

// --- Raw line editor with tab completion ---

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*m/g, "");
}

interface CompletionResult {
  matches: string[];
  completed: string;
  prefix: string;
}

function pathComplete(input: string, dirOnly: boolean): CompletionResult | null {
  try {
    let dir: string;
    let prefix: string;
    let dirPrefix: string;

    if (input === "") {
      dir = ".";
      prefix = "";
      dirPrefix = "";
    } else if (input.endsWith("/")) {
      dir = input;
      prefix = "";
      dirPrefix = input;
    } else {
      dir = dirname(input);
      prefix = basename(input);
      dirPrefix = dir === "." && !input.includes("/") ? "" : dir + "/";
    }

    const resolvedDir = resolve(process.cwd(), dir);
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(resolvedDir, { withFileTypes: true });
    } catch {
      return null;
    }

    const filtered = entries
      .filter((e) => {
        if (dirOnly && !e.isDirectory()) return false;
        return e.name.startsWith(prefix);
      })
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    if (filtered.length === 0) return null;

    const matches = filtered.map((e) => e.name + (e.isDirectory() ? "/" : ""));

    let common = filtered[0].name;
    for (let i = 1; i < filtered.length; i++) {
      while (common.length > 0 && !filtered[i].name.startsWith(common)) {
        common = common.slice(0, -1);
      }
    }

    let completed = dirPrefix + common;
    if (filtered.length === 1 && filtered[0].isDirectory()) {
      completed += "/";
    }

    return { matches, completed, prefix: dirPrefix };
  } catch {
    return null;
  }
}

const dirComplete = (input: string) => pathComplete(input, true);
const fileComplete = (input: string) => pathComplete(input, false);

function completionGridCols(items: string[], width: number): number {
  if (items.length === 0) return 1;
  const maxLen = Math.max(...items.map((s) => s.length));
  return Math.max(1, Math.floor((width - 4) / (maxLen + 2)));
}

function renderCompletionGrid(items: string[], width: number, selectedIndex: number): string[] {
  if (items.length === 0) return [];
  const maxLen = Math.max(...items.map((s) => s.length));
  const colWidth = maxLen + 2;
  const cols = Math.max(1, Math.floor((width - 4) / colWidth));
  const rows: string[] = [];
  for (let i = 0; i < items.length; i += cols) {
    let row = "";
    for (let j = i; j < Math.min(i + cols, items.length); j++) {
      const padded = items[j].padEnd(colWidth);
      row += j === selectedIndex ? pc.inverse(padded) : pc.dim(padded);
    }
    rows.push(row);
  }
  return rows;
}

function readLineRaw(
  promptStr: string,
  completer?: (input: string) => CompletionResult | null,
): string | null {
  if (!process.stdin.isTTY) {
    return prompt(promptStr);
  }

  const promptWidth = stripAnsi(promptStr).length;
  const termCols = process.stdout.columns || 80;
  let buffer = "";
  let cursor = 0;

  // Completion state
  let compMatches: string[] = [];
  let compPrefix = "";
  let selectMode = false;
  let selectIndex = 0;
  let selectCols = 1;
  let savedBuffer = "";
  let savedCursor = 0;

  const clearComp = () => {
    compMatches = [];
    compPrefix = "";
    selectMode = false;
    selectIndex = 0;
  };

  const applySelection = (idx: number) => {
    buffer = compPrefix + compMatches[idx];
    cursor = buffer.length;
  };

  const render = () => {
    process.stdout.write(`\r\x1B[J`);
    process.stdout.write(`${promptStr}${buffer}`);

    if (compMatches.length > 1) {
      const rows = renderCompletionGrid(compMatches, termCols, selectMode ? selectIndex : -1);
      for (const row of rows) {
        process.stdout.write(`\n  ${row}`);
      }
      if (rows.length > 0) {
        process.stdout.write(`\x1B[${rows.length}A`);
      }
    }

    const col = promptWidth + cursor;
    process.stdout.write("\r");
    if (col > 0) process.stdout.write(`\x1B[${col}C`);
  };

  process.stdout.write(promptStr);
  process.stdin.setRawMode(true);
  try {
    while (true) {
      const key = readKey();

      // Enter
      if (key === "\r" || key === "\n") {
        if (selectMode) {
          clearComp();
          render();
          continue;
        }
        clearComp();
        render();
        process.stdout.write("\n");
        return buffer;
      }

      // Ctrl+C
      if (key === "\x03") {
        clearComp();
        render();
        process.stdout.write("\n");
        process.exit(0);
      }

      // Ctrl+D on empty buffer
      if (key === "\x04" && buffer === "") {
        clearComp();
        render();
        process.stdout.write("\n");
        return null;
      }

      // Escape
      if (key === "\x1B") {
        if (selectMode) {
          buffer = savedBuffer;
          cursor = savedCursor;
          clearComp();
          render();
          continue;
        }
        if (compMatches.length > 0) {
          clearComp();
          render();
          continue;
        }
        render();
        process.stdout.write("\n");
        return null;
      }

      // Tab
      if (key === "\t" && completer) {
        if (compMatches.length > 1) {
          if (!selectMode) {
            // Second tab: enter select mode
            selectMode = true;
            selectIndex = 0;
            selectCols = completionGridCols(compMatches, termCols);
            savedBuffer = buffer;
            savedCursor = cursor;
            applySelection(0);
          } else {
            // Already selecting: next item
            selectIndex = (selectIndex + 1) % compMatches.length;
            applySelection(selectIndex);
          }
        } else {
          // First tab: run completer
          const result = completer(buffer.slice(0, cursor));
          if (result) {
            const after = buffer.slice(cursor);
            buffer = result.completed + after;
            cursor = result.completed.length;
            if (result.matches.length > 1) {
              compMatches = result.matches;
              compPrefix = result.prefix;
            }
          }
        }
        render();
        continue;
      }

      // Shift+Tab
      if (key === "\x1B[Z" && selectMode) {
        selectIndex = (selectIndex - 1 + compMatches.length) % compMatches.length;
        applySelection(selectIndex);
        render();
        continue;
      }

      // Arrow keys in select mode
      if (selectMode) {
        let handled = true;
        if (key === "\x1B[C" || key === "\x1BOC") {
          selectIndex = (selectIndex + 1) % compMatches.length;
        } else if (key === "\x1B[D" || key === "\x1BOD") {
          selectIndex = (selectIndex - 1 + compMatches.length) % compMatches.length;
        } else if (key === "\x1B[B" || key === "\x1BOB") {
          const next = selectIndex + selectCols;
          if (next < compMatches.length) {
            selectIndex = next;
          } else {
            // Wrap to top of same column
            selectIndex = selectIndex % selectCols;
          }
        } else if (key === "\x1B[A" || key === "\x1BOA") {
          const prev = selectIndex - selectCols;
          if (prev >= 0) {
            selectIndex = prev;
          } else {
            // Wrap to bottom of same column
            const col = selectIndex % selectCols;
            let last = col;
            while (last + selectCols < compMatches.length) last += selectCols;
            selectIndex = last;
          }
        } else {
          handled = false;
        }
        if (handled) {
          applySelection(selectIndex);
          render();
          continue;
        }
        // Non-navigation key: exit select mode, fall through to normal processing
        clearComp();
      } else if (compMatches.length > 0) {
        // Completions shown but not selecting: any key clears them
        clearComp();
      }

      // Normal key processing
      if (key === "\x7F" || key === "\x08") {
        if (cursor > 0) {
          buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
          cursor--;
        }
      } else if (key === "\x1B[D" || key === "\x1BOD") {
        if (cursor > 0) cursor--;
      } else if (key === "\x1B[C" || key === "\x1BOC") {
        if (cursor < buffer.length) cursor++;
      } else if (key === "\x1B[H" || key === "\x1BOH" || key === "\x1B[1~" || key === "\x01") {
        cursor = 0;
      } else if (key === "\x1B[F" || key === "\x1BOF" || key === "\x1B[4~" || key === "\x05") {
        cursor = buffer.length;
      } else if (key === "\x1B[3~") {
        if (cursor < buffer.length) {
          buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
        }
      } else if (key === "\x15") {
        buffer = buffer.slice(cursor);
        cursor = 0;
      } else if (key.length === 1 && key.charCodeAt(0) >= 32) {
        buffer = buffer.slice(0, cursor) + key + buffer.slice(cursor);
        cursor++;
      }

      render();
    }
  } finally {
    process.stdin.setRawMode(false);
  }
}

export function askMultiSelect(
  question: string,
  items: string[],
  selected: Set<string>,
  onChange?: (selected: Set<string>) => void,
): void {
  if (!process.stdin.isTTY || items.length === 0) return;

  const termCols = process.stdout.columns || 80;
  const maxItemLen = Math.max(...items.map((s) => s.length));
  const cellWidth = maxItemLen + 6; // "[x] " prefix + 2 gap
  const cols = Math.max(1, Math.floor((termCols - 2) / cellWidth));
  const promptWidth = 4; // "  > "

  let filter = "";
  let filterCursor = 0;
  let selectMode = false;
  let selectIndex = 0;

  const getFiltered = (): string[] => {
    if (!filter) return items;
    const lower = filter.toLowerCase();
    return items.filter((i) => i.toLowerCase().includes(lower));
  };

  const fireChange = () => {
    if (onChange) onChange(selected);
  };

  const render = (filtered: string[]) => {
    process.stdout.write(`\r\x1B[J`);
    process.stdout.write(`  > ${filter}`);

    if (filtered.length > 0) {
      const gridRows = Math.ceil(filtered.length / cols);
      for (let r = 0; r < gridRows; r++) {
        let line = "  ";
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          if (idx >= filtered.length) break;
          const item = filtered[idx];
          const check = selected.has(item) ? pc.green("[x]") : pc.dim("[ ]");
          const name = item.padEnd(maxItemLen);
          if (selectMode && idx === selectIndex) {
            line += `${check} ${pc.inverse(name)}  `;
          } else {
            line += `${check} ${name}  `;
          }
        }
        process.stdout.write(`\n${line}`);
      }
    } else {
      process.stdout.write(`\n  ${pc.dim("(no matches)")}`);
    }

    const hint = selectMode
      ? "Arrows navigate · Space/Enter toggle · a all · Esc filter · Backspace back"
      : "Type to filter · Tab/arrows select · a all · Backspace back";
    process.stdout.write(`\n\n  ${pc.dim(hint)}`);

    // Move cursor back to input line
    const linesBelow = (filtered.length > 0 ? Math.ceil(filtered.length / cols) : 1) + 2;
    process.stdout.write(`\x1B[${linesBelow}A`);
    process.stdout.write(`\r`);
    const col = promptWidth + filterCursor;
    if (col > 0) process.stdout.write(`\x1B[${col}C`);
  };

  console.log();
  console.log(`  ${pc.bold(question)}`);
  console.log();

  let filtered = getFiltered();
  render(filtered);

  process.stdin.setRawMode(true);
  try {
    while (true) {
      const key = readKey();

      if (key === "\x03") process.exit(0);

      // Escape
      if (key === "\x1B") {
        if (selectMode) {
          selectMode = false;
          render(filtered);
          continue;
        }
        return;
      }

      // Backspace
      if (key === "\x7F" || key === "\x08") {
        if (selectMode) {
          selectMode = false;
          render(filtered);
          continue;
        }
        if (filter === "") return;
        if (filterCursor > 0) {
          filter = filter.slice(0, filterCursor - 1) + filter.slice(filterCursor);
          filterCursor--;
          filtered = getFiltered();
          selectIndex = 0;
          render(filtered);
        }
        continue;
      }

      // Tab
      if (key === "\t") {
        if (filtered.length === 0) continue;
        if (!selectMode) {
          selectMode = true;
          selectIndex = 0;
        } else {
          selectIndex = (selectIndex + 1) % filtered.length;
        }
        render(filtered);
        continue;
      }

      // Shift+Tab
      if (key === "\x1B[Z") {
        if (selectMode && filtered.length > 0) {
          selectIndex = (selectIndex - 1 + filtered.length) % filtered.length;
          render(filtered);
        }
        continue;
      }

      // Select mode key handling
      if (selectMode) {
        if (key === "\x1B[C" || key === "\x1BOC") {
          selectIndex = (selectIndex + 1) % filtered.length;
          render(filtered);
          continue;
        }
        if (key === "\x1B[D" || key === "\x1BOD") {
          selectIndex = (selectIndex - 1 + filtered.length) % filtered.length;
          render(filtered);
          continue;
        }
        if (key === "\x1B[B" || key === "\x1BOB") {
          const next = selectIndex + cols;
          selectIndex = next < filtered.length ? next : selectIndex % cols;
          render(filtered);
          continue;
        }
        if (key === "\x1B[A" || key === "\x1BOA") {
          const prev = selectIndex - cols;
          if (prev >= 0) {
            selectIndex = prev;
          } else {
            const c = selectIndex % cols;
            let last = c;
            while (last + cols < filtered.length) last += cols;
            selectIndex = last;
          }
          render(filtered);
          continue;
        }
        // Space/Enter: toggle
        if (key === " " || key === "\r" || key === "\n") {
          const item = filtered[selectIndex];
          if (selected.has(item)) {
            selected.delete(item);
          } else {
            selected.add(item);
          }
          render(filtered);
          fireChange();
          continue;
        }
        // a: toggle all filtered
        if (key === "a" || key === "A") {
          const allSelected = filtered.every((i) => selected.has(i));
          if (allSelected) {
            for (const item of filtered) selected.delete(item);
          } else {
            for (const item of filtered) selected.add(item);
          }
          render(filtered);
          fireChange();
          continue;
        }
        // Any other key: exit select mode, fall through to typing
        selectMode = false;
      }

      // Typing mode: Up/Down/Enter enter select mode
      if (key === "\x1B[A" || key === "\x1BOA" || key === "\x1B[B" || key === "\x1BOB" || key === "\r" || key === "\n") {
        if (filtered.length > 0) {
          selectMode = true;
          selectIndex = 0;
          render(filtered);
        }
        continue;
      }

      // a: toggle all (typing mode with empty filter)
      if ((key === "a" || key === "A") && filter === "") {
        const allSelected = items.every((i) => selected.has(i));
        if (allSelected) {
          selected.clear();
        } else {
          for (const item of items) selected.add(item);
        }
        filtered = getFiltered();
        render(filtered);
        fireChange();
        continue;
      }

      // Left/Right: move cursor in filter
      if (key === "\x1B[D" || key === "\x1BOD") {
        if (filterCursor > 0) filterCursor--;
        render(filtered);
        continue;
      }
      if (key === "\x1B[C" || key === "\x1BOC") {
        if (filterCursor < filter.length) filterCursor++;
        render(filtered);
        continue;
      }

      // Home/End
      if (key === "\x1B[H" || key === "\x1BOH" || key === "\x1B[1~" || key === "\x01") {
        filterCursor = 0;
        render(filtered);
        continue;
      }
      if (key === "\x1B[F" || key === "\x1BOF" || key === "\x1B[4~" || key === "\x05") {
        filterCursor = filter.length;
        render(filtered);
        continue;
      }

      // Ctrl+U: clear before cursor
      if (key === "\x15") {
        filter = filter.slice(filterCursor);
        filterCursor = 0;
        filtered = getFiltered();
        selectIndex = 0;
        render(filtered);
        continue;
      }

      // Delete key
      if (key === "\x1B[3~") {
        if (filterCursor < filter.length) {
          filter = filter.slice(0, filterCursor) + filter.slice(filterCursor + 1);
          filtered = getFiltered();
          selectIndex = 0;
          render(filtered);
        }
        continue;
      }

      // Printable character
      if (key.length === 1 && key.charCodeAt(0) >= 32) {
        filter = filter.slice(0, filterCursor) + key + filter.slice(filterCursor);
        filterCursor++;
        filtered = getFiltered();
        if (selectIndex >= filtered.length) selectIndex = Math.max(0, filtered.length - 1);
        render(filtered);
        continue;
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    // Clear input line + grid + hint, then header (blank + title + blank)
    process.stdout.write(`\r\x1B[J`);
    process.stdout.write(`\x1B[3A\x1B[J`);
  }
}

export function askPath(question: string, defaultPath: string): string {
  console.log();
  console.log(`  ${pc.bold(question)}`);
  const promptStr = `  ${pc.dim(`[${defaultPath}]`)}> `;
  const input = readLineRaw(promptStr, dirComplete);
  if (input === null) {
    process.exit(0);
  }
  const value = input.trim() || defaultPath;
  return value.replace(/\/+$/, "") || ".";
}
