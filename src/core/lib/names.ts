/** Whether `name` is `original` or the name it gets when that is taken: "Rechnung (2).pdf" for "Rechnung.pdf". */
export function sameOrRenamed(name: string, original: string): boolean {
  if (name === original) return true;
  const dot = original.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [original.slice(0, dot), original.slice(dot)] : [original, ''];
  return name.startsWith(`${stem} (`) && name.endsWith(`)${ext}`) && /^\d+$/.test(name.slice(stem.length + 2, name.length - ext.length - 1));
}
