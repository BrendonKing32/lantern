// Small runtime checks for what the server sends back. Each check returns the
// value unchanged when it has the expected shape and throws a ShapeError
// naming the first place it doesn't. Typing a schema as Check<SomeType> makes
// the compiler hold it to that type, so the two can't quietly drift apart.

export type Check<T> = (value: unknown, path: string) => T;

export class ShapeError extends Error {
  constructor(public path: string, public expected: string, value: unknown) {
    super(`${path || "response"}: expected ${expected}, got ${describe(value)}`);
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  if (typeof value === "object") return "an object";
  return String(value);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const primitive =
  <T>(expected: string, test: (v: unknown) => boolean): Check<T> =>
  (v, path) => {
    if (!test(v)) throw new ShapeError(path, expected, v);
    return v as T;
  };

export const string: Check<string> = primitive("a string", (v) => typeof v === "string");
export const number: Check<number> = primitive("a number", (v) => typeof v === "number" && Number.isFinite(v));
export const boolean: Check<boolean> = primitive("true or false", (v) => typeof v === "boolean");

export function literal<const V extends readonly (string | number | boolean)[]>(...values: V): Check<V[number]> {
  const expected = values.map((x) => JSON.stringify(x)).join(" or ");
  return primitive(expected, (v) => values.includes(v as V[number]));
}

export const nullable =
  <T>(check: Check<T>): Check<T | null> =>
  (v, path) =>
    v === null ? null : check(v, path);

/** A field that may be left out (or sent as undefined). */
export const optional =
  <T>(check: Check<T>): Check<T | undefined> =>
  (v, path) =>
    v === undefined ? undefined : check(v, path);

export const array =
  <T>(item: Check<T>): Check<T[]> =>
  (v, path) => {
    if (!Array.isArray(v)) throw new ShapeError(path, "an array", v);
    v.forEach((x, i) => item(x, `${path}[${i}]`));
    return v as T[];
  };

type Shape = Record<string, Check<unknown>>;
type FromShape<S extends Shape> = { [K in keyof S]: ReturnType<S[K]> };

/** An object with at least these fields. Extra fields are allowed and kept. */
export const object =
  <S extends Shape>(shape: S): Check<FromShape<S>> =>
  (v, path) => {
    if (!isRecord(v)) throw new ShapeError(path, "an object", v);
    for (const key of Object.keys(shape)) shape[key](v[key], path ? `${path}.${key}` : key);
    return v as FromShape<S>;
  };

/** One of several object shapes, picked by the string in its `tag` field. */
export function tagged<K extends string, M extends Record<string, Check<unknown>>>(
  tag: K,
  variants: M,
): Check<{ [T in keyof M]: ReturnType<M[T]> }[keyof M]> {
  const names = Object.keys(variants);
  const pick = literal(...names);
  return (v, path) => {
    if (!isRecord(v)) throw new ShapeError(path, "an object", v);
    const name = pick(v[tag], path ? `${path}.${tag}` : tag);
    return variants[name](v, path) as ReturnType<M[keyof M]>;
  };
}
