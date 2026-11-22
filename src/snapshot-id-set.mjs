export class SortedSnapshotIds {
  #ids;

  constructor(ids) {
    if (!(ids instanceof Set)) throw TypeError('Snapshot IDs must be a Set');
    this.#ids = new Float64Array(ids.size);
    let offset = 0;
    for (const id of ids) {
      if (!Number.isSafeInteger(id) || id < 0) throw TypeError('Snapshot IDs must be nonnegative safe integers');
      this.#ids[offset++] = id;
    }
    this.#ids.sort();
  }

  get size() { return this.#ids.length; }

  has(id) {
    if (!Number.isSafeInteger(id) || id < 0) return false;
    let lower = 0, upper = this.#ids.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2), value = this.#ids[middle];
      if (value === id) return true;
      if (value < id) lower = middle + 1;
      else upper = middle;
    }
    return false;
  }

  [Symbol.iterator]() { return this.#ids.values(); }
}
