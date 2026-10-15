/**
 * Uniform grid rebuilt every step with a counting sort: no per-frame allocations,
 * O(n) build, neighbour queries only touch the 3×3 surrounding cells.
 */
export class SpatialHash {
  readonly cellSize: number;
  cols = 0;
  rows = 0;
  #originX = 0;
  #originY = 0;
  cellStart = new Int32Array(1);
  cellItems: Int32Array;
  #cellOf: Int32Array;

  constructor(capacity: number, cellSize: number) {
    this.cellSize = cellSize;
    this.cellItems = new Int32Array(capacity);
    this.#cellOf = new Int32Array(capacity);
  }

  /** Sizes the grid to cover a centred world of `width`×`height` plus a margin. */
  resize(width: number, height: number, margin = 200): void {
    this.#originX = -width / 2 - margin;
    this.#originY = -height / 2 - margin;
    this.cols = Math.ceil((width + margin * 2) / this.cellSize);
    this.rows = Math.ceil((height + margin * 2) / this.cellSize);
    this.cellStart = new Int32Array(this.cols * this.rows + 1);
  }

  cellX(x: number): number {
    const c = Math.floor((x - this.#originX) / this.cellSize);
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  cellY(y: number): number {
    const c = Math.floor((y - this.#originY) / this.cellSize);
    return c < 0 ? 0 : c >= this.rows ? this.rows - 1 : c;
  }

  build(px: Float32Array, py: Float32Array, alive: Uint8Array, count: number): void {
    const start = this.cellStart;
    start.fill(0);
    const cellOf = this.#cellOf;
    for (let i = 0; i < count; i++) {
      if (!alive[i]) {
        cellOf[i] = -1;
        continue;
      }
      const c = this.cellY(py[i]!) * this.cols + this.cellX(px[i]!);
      cellOf[i] = c;
      start[c + 1]!++;
    }
    for (let c = 1; c < start.length; c++) start[c]! += start[c - 1]!;
    // Second pass places items; cellStart[c] is used as a moving cursor and restored after.
    for (let i = 0; i < count; i++) {
      const c = cellOf[i]!;
      if (c >= 0) this.cellItems[start[c]!++] = i;
    }
    for (let c = start.length - 1; c > 0; c--) start[c] = start[c - 1]!;
    start[0] = 0;
  }
}
