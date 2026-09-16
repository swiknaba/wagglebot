import { tokenize } from "./tokenize";

const K1 = 1.2;
const B = 0.75;

export type Ranked<T> = {
  item: T;
  score: number;
};

type IndexedDocument<T> = {
  item: T;
  id: string;
  inputIndex: number;
  termFrequency: Map<string, number>;
  length: number;
};

export class Bm25Index<T> {
  readonly #documents: IndexedDocument<T>[];
  readonly #documentFrequency: Map<string, number>;
  readonly #averageDocumentLength: number;

  constructor(items: readonly T[], textOf: (item: T) => string, idOf?: (item: T) => string) {
    this.#documentFrequency = new Map();
    this.#documents = items.map((item, inputIndex) => {
      const tokens = tokenize(textOf(item));
      const termFrequency = new Map<string, number>();

      for (const token of tokens) {
        termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
      }
      for (const token of termFrequency.keys()) {
        this.#documentFrequency.set(token, (this.#documentFrequency.get(token) ?? 0) + 1);
      }

      return {
        item,
        id: idOf?.(item) ?? String(inputIndex),
        inputIndex,
        termFrequency,
        length: tokens.length,
      };
    });
    this.#averageDocumentLength =
      this.#documents.length === 0
        ? 0
        : this.#documents.reduce((total, document) => total + document.length, 0) / this.#documents.length;
  }

  search(query: string, limit: number): Ranked<T>[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) return [];

    const queryTerms = tokenize(query);
    if (queryTerms.length === 0 || this.#documents.length === 0 || this.#averageDocumentLength === 0) return [];

    const documentCount = this.#documents.length;
    const scored = this.#documents
      .map((document) => {
        let score = 0;

        for (const term of queryTerms) {
          const frequency = document.termFrequency.get(term) ?? 0;
          const documentFrequency = this.#documentFrequency.get(term) ?? 0;
          if (frequency === 0 || documentFrequency === 0) continue;

          const inverseDocumentFrequency = Math.log(
            1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5),
          );
          const denominator = frequency + K1 * (1 - B + (B * document.length) / this.#averageDocumentLength);
          score += inverseDocumentFrequency * ((frequency * (K1 + 1)) / denominator);
        }

        return { document, score };
      })
      .filter((result) => result.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        if (left.document.inputIndex !== right.document.inputIndex)
          return left.document.inputIndex - right.document.inputIndex;
        return left.document.id < right.document.id ? -1 : left.document.id > right.document.id ? 1 : 0;
      });

    return scored.slice(0, limit).map(({ document, score }) => ({ item: document.item, score }));
  }
}
