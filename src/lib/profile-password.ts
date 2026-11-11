// Profile PINs. New hashes use PBKDF2 with a random salt per PIN ("pbkdf2$iter$salt$hash"); a
// fixed-salt SHA-256 of a 4-digit PIN could be reversed instantly from storage. Old hashes still
// verify. Wrong tries slow down (up to 30 s per try), so guessing all 10,000 PINs takes days.

const LEGACY_SALT = "harbor-profile-v1";
const ITERATIONS = 150_000;

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function legacyHash(password: string): Promise<string> {
  const data = new TextEncoder().encode(`${LEGACY_SALT}|${password}`);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return hex(new Uint8Array(bits));
}

export async function hashProfilePassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${hex(salt)}$${await pbkdf2(password, salt, ITERATIONS)}`;
}

let failures = 0;

export async function verifyProfilePassword(password: string, hash: string): Promise<boolean> {
  if (!hash) return false;
  let ok: boolean;
  if (hash.startsWith("pbkdf2$")) {
    const [, iter, salt, want] = hash.split("$");
    ok = (await pbkdf2(password, unhex(salt ?? ""), Number(iter) || ITERATIONS)) === want;
  } else {
    ok = (await legacyHash(password)) === hash;
  }
  if (ok) {
    failures = 0;
    return true;
  }
  failures++;
  // 1st-3rd wrong try: at once; then 1 s, 2 s, 4 s … up to 30 s before answering.
  const delay = failures <= 3 ? 0 : Math.min(30_000, 1000 * 2 ** (failures - 4));
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  return false;
}
