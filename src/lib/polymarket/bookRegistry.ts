import { BookState } from "@wiggler/lib/polymarket/bookState";

/**
 * Mapping of CLOB asset id -> BookState for every subscribed Polymarket asset.
 */
export class BookRegistry {
  readonly #books = new Map<string, BookState>();

  getOrCreate(assetId: string): BookState {
    let book = this.#books.get(assetId);
    if (!book) {
      book = new BookState(assetId);
      this.#books.set(assetId, book);
    }
    return book;
  }

  get(assetId: string): BookState | undefined {
    return this.#books.get(assetId);
  }

  list(): readonly BookState[] {
    return [...this.#books.values()];
  }

  size(): number {
    return this.#books.size;
  }
}
