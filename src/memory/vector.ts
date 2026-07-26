import { MemoryError } from "./contracts";

export function normalizeEmbedding(
  values: readonly number[],
  dimensions: number,
): Float32Array {
  requireDimensions(dimensions);
  if (values.length !== dimensions) {
    throw new MemoryError(
      "memory_embedding_dimensions_invalid",
      `Embedding has ${values.length} dimensions; expected ${dimensions}.`,
    );
  }
  if (values.some((value) => !Number.isFinite(value))) {
    throw new MemoryError(
      "memory_embedding_values_invalid",
      "Embedding contains a non-finite value.",
    );
  }

  const rawNorm = vectorNorm(values);
  if (!Number.isFinite(rawNorm) || rawNorm === 0) {
    throw new MemoryError(
      "memory_embedding_norm_invalid",
      "Embedding norm must be finite and non-zero.",
    );
  }

  const normalized = new Float32Array(
    values.map((value) => Math.fround(value / rawNorm)),
  );
  const floatNorm = vectorNorm(normalized);
  if (!Number.isFinite(floatNorm) || floatNorm === 0) {
    throw new MemoryError(
      "memory_embedding_norm_invalid",
      "Embedding became zero or non-finite after Float32 conversion.",
    );
  }
  for (let index = 0; index < normalized.length; index += 1) {
    normalized[index] = Math.fround(normalized[index] / floatNorm);
  }
  return normalized;
}

export function encodeEmbedding(vector: Float32Array): Uint8Array {
  const bytes = new Uint8Array(vector.length * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index];
    if (!Number.isFinite(value)) {
      throw new MemoryError(
        "memory_embedding_values_invalid",
        "Embedding contains a non-finite Float32 value.",
      );
    }
    view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, value, true);
  }
  return bytes;
}

export function decodeEmbedding(
  value: unknown,
  expectedBlobBytes: number,
): Float32Array {
  if (!(value instanceof Uint8Array)) {
    throw new MemoryError(
      "memory_embedding_blob_invalid",
      "Stored memory embedding is not a SQLite BLOB.",
    );
  }
  if (value.byteLength !== expectedBlobBytes) {
    throw new MemoryError(
      "memory_embedding_blob_invalid",
      `Stored memory embedding has ${value.byteLength} bytes; expected ${expectedBlobBytes}.`,
    );
  }

  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const dimensions = expectedBlobBytes / Float32Array.BYTES_PER_ELEMENT;
  const vector = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    const decoded = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
    if (!Number.isFinite(decoded)) {
      throw new MemoryError(
        "memory_embedding_blob_invalid",
        "Stored memory embedding contains a non-finite value.",
      );
    }
    vector[index] = decoded;
  }
  return vector;
}

export function cosineFromNormalized(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || left.length === 0) {
    throw new MemoryError(
      "memory_embedding_dimensions_invalid",
      "Cosine vectors must have the same non-zero dimensions.",
    );
  }
  let score = 0;
  for (let index = 0; index < left.length; index += 1) {
    score += left[index] * right[index];
  }
  if (!Number.isFinite(score)) {
    throw new MemoryError(
      "memory_embedding_values_invalid",
      "Cosine score is not finite.",
    );
  }
  return score;
}

export function expectedEmbeddingBlobBytes(dimensions: number): number {
  requireDimensions(dimensions);
  const bytes = dimensions * Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    throw new MemoryError(
      "memory_embedding_dimensions_invalid",
      "Embedding byte length is not a positive safe integer.",
    );
  }
  return bytes;
}

function requireDimensions(dimensions: number): void {
  if (!Number.isSafeInteger(dimensions) || dimensions < 1) {
    throw new MemoryError(
      "memory_embedding_dimensions_invalid",
      "Embedding dimensions must be a positive safe integer.",
    );
  }
}

function vectorNorm(values: ArrayLike<number>): number {
  let scale = 0;
  let sumSquares = 1;
  for (let index = 0; index < values.length; index += 1) {
    const absolute = Math.abs(values[index]);
    if (absolute === 0) {
      continue;
    }
    if (scale < absolute) {
      const ratio = scale / absolute;
      sumSquares = 1 + sumSquares * ratio * ratio;
      scale = absolute;
    } else {
      const ratio = absolute / scale;
      sumSquares += ratio * ratio;
    }
  }
  return scale === 0 ? 0 : scale * Math.sqrt(sumSquares);
}
