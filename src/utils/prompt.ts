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

function layoutWidth(): number {
  return process.stdout.columns || 80;
}

function truncate(s: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

function renderItemGrid(
  labels: string[],
  cellWidth: number,
  gridCols: number,
  selected: number,
): string[] {
  const rows: string[] = [];
  for (let i = 0; i < labels.length; i += gridCols) {
    let row = "  ";
    for (let j = i; j < Math.min(i + gridCols, labels.length); j++) {
      const padded = labels[j].padEnd(cellWidth);
      row += j === selected ? pc.inverse(padded) : padded;
    }
    rows.push(row);
  }
  return rows;
}

function renderAskView(
  options: Option[],
  selected: number,
  hint: string,
  cellWidth: number,
  gridCols: number,
  descHeight: number,
  helpHeight: number,
): number {
  const labels = options.map((o) => o.label);
  const gridRows = renderItemGrid(labels, cellWidth, gridCols, selected);

  let lines = 0;
  for (const row of gridRows) {
    process.stdout.write(`${row}\n`);
    lines++;
  }

  // Hint line
  process.stdout.write(`\n  ${pc.dim(hint)}\n`);
  lines += 2;

  // Description of selected item
  if (descHeight > 0) {
    const descText = options[selected]?.description ?? "";
    if (descText) {
      process.stdout.write(`  ${pc.dim(truncate(descText, layoutWidth() - 2))}\n`);
    } else {
      process.stdout.write(`\x1B[2K\n`);
    }
    lines++;
  }

  // Blank line between description and help
  if (descHeight > 0 && helpHeight > 0) {
    process.stdout.write("\n");
    lines++;
  }

  // Help text of selected item
  if (helpHeight > 0) {
    const helpLines = options[selected]?.help?.split("\n") ?? [];
    for (let i = 0; i < helpHeight; i++) {
      if (i < helpLines.length) {
        process.stdout.write(`  ${pc.dim(truncate(helpLines[i], layoutWidth() - 2))}\n`);
      } else {
        process.stdout.write(`\x1B[2K\n`);
      }
      lines++;
    }
  }

  return lines;
}

function askFallback(question: string, options: Option[]): number {
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
    if (input === null) return -1;
    const trimmed = input.trim().toLowerCase();
    if (trimmed === "q" || trimmed === "b") return -1;
    const n = parseInt(trimmed, 10);
    if (n >= 1 && n <= options.length) return n - 1;
    console.log(pc.red(`  Enter 1-${options.length} or q to go back`));
  }
}

export async function ask(
  question: string,
  options: Option[],
  opts: { exit?: boolean } = {},
): Promise<number> {
  if (options.length === 0) return -1;

  const isExit = opts.exit === true;
  const backLabel = isExit ? "⌫ exit" : "⌫ back";
  const hint = `←→↑↓ navigate · ⏎ select · ${backLabel}`;

  if (!process.stdin.isTTY) {
    return askFallback(question, options);
  }

  const maxLabel = Math.max(...options.map((o) => o.label.length));
  const cellWidth = maxLabel + 2;
  const gridCols = Math.max(1, Math.floor((layoutWidth() - 4) / cellWidth));

  // Fixed-height info areas
  const descHeight = options.some((o) => o.description) ? 1 : 0;
  const helpHeight = Math.max(0, ...options.map((o) => (o.help ? o.help.split("\n").length : 0)));

  console.log();
  console.log(`  ${pc.bold(question)}`);
  console.log();

  let selected = 0;
  let renderedLines = renderAskView(options, selected, hint, cellWidth, gridCols, descHeight, helpHeight);
  process.stdout.write(`\x1B[${renderedLines}A`);

  process.stdin.setRawMode(true);
  try {
    while (true) {
      const key = readKey();

      let newSelected = selected;

      // Left
      if (key === "\x1B[D" || key === "\x1BOD") {
        newSelected = selected > 0 ? selected - 1 : options.length - 1;
      }
      // Right
      else if (key === "\x1B[C" || key === "\x1BOC") {
        newSelected = selected < options.length - 1 ? selected + 1 : 0;
      }
      // Up
      else if (key === "\x1B[A" || key === "\x1BOA") {
        const up = selected - gridCols;
        newSelected = up >= 0 ? up : (options.length - 1 - ((options.length - 1 - selected) % gridCols));
      }
      // Down
      else if (key === "\x1B[B" || key === "\x1BOB") {
        const down = selected + gridCols;
        newSelected = down < options.length ? down : selected % gridCols;
      }
      // Tab
      else if (key === "\t") {
        newSelected = (selected + 1) % options.length;
      }
      // Shift+Tab
      else if (key === "\x1B[Z") {
        newSelected = (selected - 1 + options.length) % options.length;
      }
      // Space/Enter: select
      else if (key === "\r" || key === "\n" || key === " ") {
        return selected;
      }
      // Backspace/Escape: back
      else if (key === "\x7F" || key === "\x08" || key === "\x1B") {
        return -1;
      }
      // Ctrl+C
      else if (key === "\x03") {
        process.exit(0);
      }

      if (newSelected !== selected) {
        selected = newSelected;
        process.stdout.write(`\r\x1B[J`);
        renderedLines = renderAskView(options, selected, hint, cellWidth, gridCols, descHeight, helpHeight);
        process.stdout.write(`\x1B[${renderedLines}A`);
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdout.write(`\r\x1B[J`);
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

interface SectionLayout {
  start: number;
  count: number;
  cellWidth: number;
  gridCols: number;
}

function buildSectionLayouts(sections: DashboardSection[]): SectionLayout[] {
  const w = layoutWidth();
  const layouts: SectionLayout[] = [];
  let start = 0;
  for (const section of sections) {
    const maxLabel = section.items.length > 0
      ? Math.max(...section.items.map((i) => i.label.length))
      : 0;
    const cellWidth = maxLabel + 2;
    const gridCols = Math.max(1, Math.floor((w - 4) / cellWidth));
    layouts.push({ start, count: section.items.length, cellWidth, gridCols });
    start += section.items.length;
  }
  return layouts;
}

function navigateVertical(layouts: SectionLayout[], _total: number, selected: number, direction: "up" | "down"): number {
  // Find current section
  let sIdx = 0;
  for (let i = 0; i < layouts.length; i++) {
    if (selected >= layouts[i].start && selected < layouts[i].start + layouts[i].count) {
      sIdx = i;
      break;
    }
  }

  const layout = layouts[sIdx];
  const posInSection = selected - layout.start;
  const col = posInSection % layout.gridCols;

  if (direction === "up") {
    const row = Math.floor(posInSection / layout.gridCols);
    if (row > 0) {
      // Move up within section
      return selected - layout.gridCols;
    }
    // Jump to previous section (wrap to last)
    const prevIdx = (sIdx - 1 + layouts.length) % layouts.length;
    const prev = layouts[prevIdx];
    const lastRow = Math.floor((prev.count - 1) / prev.gridCols);
    const targetCol = Math.min(col, prev.gridCols - 1);
    return Math.min(prev.start + lastRow * prev.gridCols + targetCol, prev.start + prev.count - 1);
  } else {
    if (posInSection + layout.gridCols < layout.count) {
      // Move down within section
      return selected + layout.gridCols;
    }
    // Jump to next section (wrap to first)
    const nextIdx = (sIdx + 1) % layouts.length;
    const next = layouts[nextIdx];
    const targetCol = Math.min(col, next.gridCols - 1);
    return Math.min(next.start + targetCol, next.start + next.count - 1);
  }
}

function renderDashboardView(
  sections: DashboardSection[],
  allItems: DashboardItem[],
  selected: number,
  hint: string,
  layouts: SectionLayout[],
  valueHeight: number,
  helpHeight: number,
  statusLines: string[],
): number {
  const dividerWidth = Math.min(layoutWidth() - 4, 50);
  const divider = pc.dim("─".repeat(dividerWidth));

  let lines = 0;

  for (let s = 0; s < sections.length; s++) {
    if (s > 0) { process.stdout.write("\n"); lines++; }
    if (sections[s].title) {
      process.stdout.write(`  ${pc.bold(sections[s].title)}\n`);
      process.stdout.write(`  ${divider}\n`);
      lines += 2;
    }

    const sectionLabels = sections[s].items.map((i) => i.label);
    const { start, cellWidth, gridCols } = layouts[s];
    const sectionSelected = (selected >= start && selected < start + sectionLabels.length)
      ? selected - start
      : -1;
    const gridRows = renderItemGrid(sectionLabels, cellWidth, gridCols, sectionSelected);
    for (const row of gridRows) {
      process.stdout.write(`${row}\n`);
      lines++;
    }
  }

  // Hint line (includes action shortcuts)
  process.stdout.write(`\n  ${pc.dim(hint)}\n`);
  lines += 2;

  // Value of selected item
  if (valueHeight > 0) {
    const valueText = allItems[selected]?.value ?? "";
    if (valueText) {
      process.stdout.write(`  ${pc.dim(truncate(valueText, layoutWidth() - 2))}\n`);
    } else {
      process.stdout.write(`\x1B[2K\n`);
    }
    lines++;
  }

  // Blank line between value and help
  if (valueHeight > 0 && helpHeight > 0) {
    process.stdout.write("\n");
    lines++;
  }

  // Help text of selected item
  if (helpHeight > 0) {
    const helpLines = allItems[selected]?.help?.split("\n") ?? [];
    for (let i = 0; i < helpHeight; i++) {
      if (i < helpLines.length) {
        process.stdout.write(`  ${pc.dim(truncate(helpLines[i], layoutWidth() - 2))}\n`);
      } else {
        process.stdout.write(`\x1B[2K\n`);
      }
      lines++;
    }
  }

  // Status messages
  if (statusLines.length > 0) {
    process.stdout.write("\n");
    lines++;
    for (const line of statusLines) {
      process.stdout.write(`  ${line}\n`);
      lines++;
    }
  }

  return lines;
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
  const statusLines = opts?.status ? opts.status.split("\n") : [];

  // Per-section grid layout
  const layouts = buildSectionLayouts(sections);

  // Fixed-height info areas
  const valueHeight = allItems.some((i) => i.value) ? 1 : 0;
  const helpHeight = Math.max(0, ...allItems.map((i) => (i.help ? i.help.split("\n").length : 0)));

  // Build hint line with action shortcuts (q handled by ⌫ back)
  const visibleActions = actions.filter((a) => a.key.toLowerCase() !== "q");
  const actionHints = visibleActions.map((a) => `${pc.cyan(a.key)} ${a.label}`).join(" · ");
  const hint = actionHints
    ? `←→↑↓ navigate · ⏎ select · ${actionHints} · ⌫ back`
    : `←→↑↓ navigate · ⏎ select · ⌫ back`;

  let selected = 0;
  if (opts?.selected) {
    const idx = allItems.findIndex((i) => i.key === opts.selected);
    if (idx >= 0) selected = idx;
  }

  console.log();
  console.log(`  ${pc.bold(title)}`);
  console.log();

  if (!process.stdin.isTTY) {
    renderDashboardView(sections, allItems, selected, hint, layouts, valueHeight, helpHeight, statusLines);
    while (true) {
      const input = prompt(pc.dim(">"));
      if (input === null) return null;
      const trimmed = input.trim().toLowerCase();
      if (actionKeys.has(trimmed)) return { type: "action", key: actionKeys.get(trimmed)! };
      const n = parseInt(trimmed, 10);
      if (n >= 1 && n <= allItems.length) return { type: "item", key: allItems[n - 1].key };
    }
  }

  let renderedLines = renderDashboardView(sections, allItems, selected, hint, layouts, valueHeight, helpHeight, statusLines);
  process.stdout.write(`\x1B[${renderedLines}A`);

  process.stdin.setRawMode(true);
  try {
    while (true) {
      const key = readKey();

      let newSelected = selected;

      // Left
      if (key === "\x1B[D" || key === "\x1BOD") {
        newSelected = selected > 0 ? selected - 1 : allItems.length - 1;
      }
      // Right
      else if (key === "\x1B[C" || key === "\x1BOC") {
        newSelected = selected < allItems.length - 1 ? selected + 1 : 0;
      }
      // Up
      else if (key === "\x1B[A" || key === "\x1BOA") {
        newSelected = navigateVertical(layouts, allItems.length, selected, "up");
      }
      // Down
      else if (key === "\x1B[B" || key === "\x1BOB") {
        newSelected = navigateVertical(layouts, allItems.length, selected, "down");
      }
      // Tab
      else if (key === "\t") {
        newSelected = (selected + 1) % allItems.length;
      }
      // Shift+Tab
      else if (key === "\x1B[Z") {
        newSelected = (selected - 1 + allItems.length) % allItems.length;
      }
      // Space/Enter: select
      else if (key === "\r" || key === "\n" || key === " ") {
        return { type: "item", key: allItems[selected].key };
      }
      // Backspace/Escape: back
      else if (key === "\x1B" || key === "\x7F" || key === "\x08") {
        return null;
      }
      // Ctrl+C
      else if (key === "\x03") {
        process.exit(0);
      }
      // Action shortcut keys
      else {
        const lower = key.toLowerCase();
        if (actionKeys.has(lower)) {
          return { type: "action", key: actionKeys.get(lower)! };
        }
      }

      if (newSelected !== selected) {
        selected = newSelected;
        process.stdout.write(`\r\x1B[J`);
        renderedLines = renderDashboardView(sections, allItems, selected, hint, layouts, valueHeight, helpHeight, statusLines);
        process.stdout.write(`\x1B[${renderedLines}A`);
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    // Clear render area + title (blank + title + blank = 3 lines above)
    process.stdout.write(`\x1B[3A\r\x1B[J`);
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

  const maxItemLen = Math.max(...items.map((s) => s.length));
  const cellWidth = maxItemLen + 6; // "[x] " prefix + 2 gap
  const cols = Math.max(1, Math.floor((layoutWidth() - 2) / cellWidth));
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
