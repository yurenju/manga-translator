// kuromoji 的 DictionaryLoader 用 Node 的 path.join 拼字典網址；外掛裡沒有 path，build 時用這個代替。
export function join(...parts: string[]): string {
  return parts.join('/').replace(/([^:/])\/{2,}/g, '$1/');
}

export default { join };
