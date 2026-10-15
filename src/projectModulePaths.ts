import * as path from "path";

export function isCompanion(left: string, right: string): boolean {
  if (left === right || path.posix.dirname(left) !== path.posix.dirname(right)) return false;
  const yaml = /\.ya?ml$/i.test(left) ? left : /\.ya?ml$/i.test(right) ? right : undefined;
  const xbsl = /\.xbsl$/i.test(left) ? left : /\.xbsl$/i.test(right) ? right : undefined;
  if (!yaml || !xbsl) return false;
  const base = yaml.replace(/\.ya?ml$/i, "");
  const code = xbsl.replace(/\.xbsl$/i, "");
  return code === base || code.startsWith(`${base}.`);
}

/** Broad filename similarity is useful for retrieval, but cannot establish module ownership. */
export function isElementModuleCompanion(left: string, right: string): boolean {
  if (!isCompanion(left, right)) return false;
  const yaml = /\.ya?ml$/i.test(left) ? left : right;
  const xbsl = /\.xbsl$/i.test(left) ? left : right;
  const suffix = xbsl.replace(/\.xbsl$/i, "").slice(yaml.replace(/\.ya?ml$/i, "").length);
  return /^(?:\.(?:\u041e\u0431\u044a\u0435\u043a\u0442|Object|\u041d\u0430\u0431\u043e\u0440\u0417\u0430\u043f\u0438\u0441\u0435\u0439|RecordSet|\u0417\u0430\u043f\u0438\u0441\u044c|Record))?$/.test(suffix);
}
