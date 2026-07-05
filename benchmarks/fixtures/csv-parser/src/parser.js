export function parseLine(line) {
  return line.split(",").map((cell) => cell.trim());
}

export function parse(input) {
  const lines = input.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  const header = parseLine(lines[0]);
  const rows = [];
  // BUG: this starts at 0, so the header line is also parsed as a data row.
  for (let i = 0; i < lines.length; i++) {
    const cells = parseLine(lines[i]);
    const row = {};
    header.forEach((key, idx) => {
      row[key] = cells[idx] ?? "";
    });
    rows.push(row);
  }
  return rows;
}
