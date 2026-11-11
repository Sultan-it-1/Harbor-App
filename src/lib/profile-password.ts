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

// Wrong tries and the wait they earned are kept in storage: counted in memory only, closing
// and reopening the app gave three more free tries every time.
const GUARD_KEY = "harbor.profile-pin.guard";
const MAX_DELAY_MS = 30_000;

type Guard = { failures: number; lockUntil: number };

function readGuard(): Guard {
  try {
    const v = JSON.parse(localStorage.getItem(GUARD_KEY) ?? "null") as Partial<Guard> | null;
    const failures = Number(v?.failures);
    const lockUntil = Number(v?.lockUntil);
    return {
      failures: Number.isFinite(failures) && failures > 0 ? Math.floor(failures) : 0,
      lockUntil: Number.isFinite(lockUntil) ? lockUntil : 0,
    };
  } catch {
    return { failures: 0, lockUntil: 0 };
  }
}

function writeGuard(guard: Guard | null): void {
  try {
    if (guard) localStorage.setItem(GUARD_KEY, JSON.stringify(guard));
    else localStorage.removeItem(GUARD_KEY);
  } catch {
    /* storage full or blocked: the backoff then only lasts until the app is closed */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function verifyProfilePassword(password: string, hash: string): Promise<boolean> {
  if (!hash) return false;
  const guard = readGuard();
  // A wait that was cut short (the app closed and opened again) is finished first. Capped, so a
  // clock that was moved back can't lock the profile for long.
  const pending = guard.lockUntil - Date.now();
  if (pending > 0) await sleep(Math.min(pending, MAX_DELAY_MS));
  let ok: boolean;
  if (hash.startsWith("pbkdf2$")) {
    const [, iter, salt, want] = hash.split("$");
    ok = (await pbkdf2(password, unhex(salt ?? ""), Number(iter) || ITERATIONS)) === want;
  } else {
    ok = (await legacyHash(password)) === hash;
  }
  if (ok) {
    writeGuard(null);
    return true;
  }
  const failures = guard.failures + 1;
  // 1st-3rd wrong try: at once; then 1 s, 2 s, 4 s … up to 30 s before answering.
  const delay = failures <= 3 ? 0 : Math.min(MAX_DELAY_MS, 1000 * 2 ** (failures - 4));
  writeGuard({ failures, lockUntil: Date.now() + delay });
  if (delay > 0) await sleep(delay);
  return false;
}
