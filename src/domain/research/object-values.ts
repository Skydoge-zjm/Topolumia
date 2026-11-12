/** Copy a business value without publishing the listed internal fields. */
export function omitFields<T extends object,K extends keyof T>(value:T,keys:readonly K[]):Omit<T,K>{
  const copy={...value};
  for(const key of keys)delete copy[key];
  return copy;
}
