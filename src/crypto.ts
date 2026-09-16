// WebCrypto-only helpers (no Node Buffer) so the plugin runs on Obsidian mobile.
// Envelope format matches obsidian-bridge/envelope.js:
//   key = RSA-OAEP(SHA-256)(aesKey), iv = 12 bytes, ct = AES-256-GCM(ciphertext || tag)

export interface Envelope {
  v: number;
  key: string;
  iv: string;
  ct: string;
}

export interface NotePayload {
  filename: string;
  markdown: string;
  created_at: string;
}

export function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

const RSA_PARAMS: RsaHashedKeyGenParams = {
  name: "RSA-OAEP",
  modulusLength: 3072,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};

export async function generateKeys(): Promise<{ publicKey: string; privateKeyJwk: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey(RSA_PARAMS, true, ["encrypt", "decrypt"]);
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: bytesToB64(spki), privateKeyJwk };
}

export async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
}

// Throws if the envelope was not encrypted for this key (e.g. misrouted) or was tampered with.
export async function openEnvelope(privateKey: CryptoKey, env: Envelope): Promise<NotePayload> {
  if (!env || env.v !== 1) throw new Error("unsupported envelope");
  const raw = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, b64ToBytes(env.key));
  const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(env.iv) }, aes, b64ToBytes(env.ct));
  const note = JSON.parse(new TextDecoder().decode(plain)) as NotePayload;
  if (typeof note.markdown !== "string" || typeof note.filename !== "string") throw new Error("bad payload");
  return note;
}
