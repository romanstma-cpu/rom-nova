// Whether this is the browser-only static build (romapps.xyz/nova).
//
// Kept in its own module so that asking the question does not import the
// answer: src/lib/local.ts carries the whole in-browser engine, and anything
// that imported IS_STATIC from there pulled the engine into every page's
// first load.
export const IS_STATIC = process.env.NEXT_PUBLIC_STATIC === "1";
