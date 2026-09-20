// Globally consistent one-to-one assignment (Hungarian / Kuhn–Munkres, O(n^3)).
// A greedy row-by-row pick can hand the same sensor to two valves; this cannot.
// `weights[row][column]` is the evidence for pairing row with column; zero or
// negative weights are treated as "no evidence" and are never returned.
export function assignOneToOne(weights: number[][]): Array<number | null> {
  const rowCount = weights.length;
  const columnCount = rowCount === 0 ? 0 : Math.max(...weights.map((row) => row.length));
  if (rowCount === 0 || columnCount === 0) return new Array<number | null>(rowCount).fill(null);

  const size = Math.max(rowCount, columnCount);
  let maximum = 0;
  for (const row of weights) {
    for (const value of row) {
      if (Number.isFinite(value) && value > maximum) maximum = value;
    }
  }

  // Convert to a square minimization problem; padding cells carry no evidence.
  const cost = (row: number, column: number) => {
    const value = row < rowCount ? weights[row][column] : undefined;
    return maximum - (value != null && Number.isFinite(value) && value > 0 ? value : 0);
  };

  const rowPotential = new Array<number>(size + 1).fill(0);
  const columnPotential = new Array<number>(size + 1).fill(0);
  const columnMatch = new Array<number>(size + 1).fill(0);
  const way = new Array<number>(size + 1).fill(0);

  for (let row = 1; row <= size; row += 1) {
    columnMatch[0] = row;
    let currentColumn = 0;
    const minimum = new Array<number>(size + 1).fill(Infinity);
    const used = new Array<boolean>(size + 1).fill(false);
    do {
      used[currentColumn] = true;
      const currentRow = columnMatch[currentColumn];
      let delta = Infinity;
      let nextColumn = 0;
      for (let column = 1; column <= size; column += 1) {
        if (used[column]) continue;
        const reduced = cost(currentRow - 1, column - 1) - rowPotential[currentRow] - columnPotential[column];
        if (reduced < minimum[column]) {
          minimum[column] = reduced;
          way[column] = currentColumn;
        }
        if (minimum[column] < delta) {
          delta = minimum[column];
          nextColumn = column;
        }
      }
      for (let column = 0; column <= size; column += 1) {
        if (used[column]) {
          rowPotential[columnMatch[column]] += delta;
          columnPotential[column] -= delta;
        } else {
          minimum[column] -= delta;
        }
      }
      currentColumn = nextColumn;
    } while (columnMatch[currentColumn] !== 0);
    do {
      const previous = way[currentColumn];
      columnMatch[currentColumn] = columnMatch[previous];
      currentColumn = previous;
    } while (currentColumn !== 0);
  }

  const result = new Array<number | null>(rowCount).fill(null);
  for (let column = 1; column <= size; column += 1) {
    const row = columnMatch[column] - 1;
    if (row < 0 || row >= rowCount || column - 1 >= columnCount) continue;
    const value = weights[row][column - 1];
    if (Number.isFinite(value) && value > 0) result[row] = column - 1;
  }
  return result;
}
