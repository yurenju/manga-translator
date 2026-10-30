/** SHA-256 的十六進位字串：OTP、session token 與 Free Pages 領取紀錄的 email 都只存這個。 */
export const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
