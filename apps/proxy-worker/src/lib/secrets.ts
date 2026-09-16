/**
 * Encrypted secret store on KV.
 *
 * KV keys: `s:<namespace>:<NAME>` → value is a versioned envelope
 * `{ v: 1, n: <b64 nonce>, c: <b64 ciphertext> }`. AES-GCM, single master key
 * (`HODOR_ENCRYPTION_KEY`, a Cloudflare Secret holding base64 of 32 bytes), with the
 * record identity bound as additional authenticated data so a ciphertext cannot
 * be swapped to a different name.
 *
 * Reads are served from a per-isolate in-memory cache (5-min TTL) so secrets
 * are never read from KV on the per-request hot path after warm-up. On a cache
 * miss the KV read is fail-closed: any error (or a missing key) throws rather
 * than serving unverified/stale plaintext.
 * @module
 */
import { AppHTTPException, ErrorCodes } from "./errors";
import type { KeyValueStore } from "./runtime";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_NAMESPACE = "default";
const KEY_PREFIX = "s:";

/** Versioned encrypted envelope stored in KV. */
type Envelope = {
  v: 1;
  n: string;
  c: string;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index);
  return out;
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const IV_BYTES = 12;

/** Imports the base64 `HODOR_ENCRYPTION_KEY` into a usable AES-GCM CryptoKey. */
export async function importEncryptionKey(base64Key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", base64ToBytes(base64Key), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Constructor inputs for {@link SecretStore}. */
export interface SecretStoreInput {
  storage: KeyValueStore;
  cryptoKey: CryptoKey;
  ttlMs?: number;
}

/** A reference identifying one secret: namespace + name. */
type SecretRef = { namespace: string; name: string };

/** Decrypt an envelope with an arbitrary key (not necessarily the current one). */
async function decryptEnvelope(input: {
  kvKey: string;
  envelope: Envelope;
  cryptoKey: CryptoKey;
}): Promise<string> {
  const aad = encode(input.kvKey);
  const iv = base64ToBytes(input.envelope.n);
  const ciphertext = base64ToBytes(input.envelope.c);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    input.cryptoKey,
    ciphertext,
  );
  return new TextDecoder().decode(plain);
}

/** Encrypt plaintext with a key into the `{v,n,c}` envelope (AAD = full KV key). */
async function encryptEnvelope(input: {
  kvKey: string;
  plaintext: string;
  cryptoKey: CryptoKey;
}): Promise<Envelope> {
  const aad = encode(input.kvKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    input.cryptoKey,
    encode(input.plaintext),
  );
  return {
    v: 1,
    n: bytesToBase64(iv),
    c: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

/**
 * Encrypted secret store backed by KV with an in-memory cache.
 */
export class SecretStore {
  private readonly cache = new Map<string, { value: string; expiresAt: number }>();

  constructor(input: SecretStoreInput) {
    this.store = input.storage;
    this.cryptoKey = input.cryptoKey;
    this.ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  }

  private readonly store: KeyValueStore;
  private readonly cryptoKey: CryptoKey;
  private readonly ttlMs: number;

  /** Build the KV key for a namespace + secret name. */
  key({ namespace, name }: SecretRef): string {
    return `${KEY_PREFIX}${namespace}:${name}`;
  }

  /** The default namespace when none is supplied. */
  static defaultNamespace(): string {
    return DEFAULT_NAMESPACE;
  }

  private parseKey(kvKey: string): SecretRef {
    // `s:<ns>:<NAME>` — the name is the final segment (uppercase), ns the rest.
    const rest = kvKey.slice(KEY_PREFIX.length);
    const sep = rest.lastIndexOf(":");
    return {
      namespace: rest.slice(0, sep),
      name: rest.slice(sep + 1),
    };
  }

  private cacheKey({ namespace, name }: SecretRef): string {
    return `${namespace}:${name}`;
  }

  /**
   * Encrypt and store a plaintext secret, updating the local cache so the
   * same isolate serves the fresh value immediately.
   */
  async set(input: SecretRef & { plaintext: string }): Promise<void> {
    const { namespace, name, plaintext } = input;
    const kvKey = this.key({ namespace, name });
    const envelope = await encryptEnvelope({ kvKey, plaintext, cryptoKey: this.cryptoKey });
    await this.store.setItem(kvKey, envelope);
    this.cache.set(this.cacheKey({ namespace, name }), {
      value: plaintext,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /**
   * Read + decrypt a secret. Cache hit returns immediately; a miss reads KV
   * and is **fail-closed** — a missing key or a KV error throws.
   */
  async get(input: SecretRef): Promise<string> {
    const cached = this.cache.get(this.cacheKey(input));
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const kvKey = this.key(input);
    const envelope = await this.store.getItem<Envelope>(kvKey).catch(() => null);
    if (!envelope) {
      throw new AppHTTPException({
        message: `Secret ${input.namespace}:${input.name} not found`,
        code: ErrorCodes.NOT_FOUND,
        status: 404,
      });
    }
    const plaintext = await decryptEnvelope({ kvKey, envelope, cryptoKey: this.cryptoKey });
    this.cache.set(this.cacheKey(input), {
      value: plaintext,
      expiresAt: Date.now() + this.ttlMs,
    });
    return plaintext;
  }

  /**
   * Re-encrypt every stored secret under {@link this.cryptoKey} (the current
   * `HODOR_ENCRYPTION_KEY`), decrypting each with an externally-supplied old key.
   * Used to rotate the master key: the caller passes the previous key in the
   * request body; the store reads each `s:*` value, decrypts with the old key,
   * and writes a fresh envelope under the current key.
   * Returns the ids that were re-keyed.
   */
  async rekey(input: {
    oldCryptoKey: CryptoKey;
  }): Promise<{ rekeyed: string[]; failures: Record<string, string> }> {
    const names = await this.store.getKeys(KEY_PREFIX);
    const rekeyed: string[] = [];
    const failures: Record<string, string> = {};
    for (const name of names) {
      const kvKey = name;
      try {
        const old = await this.store.getItem<Envelope>(kvKey);
        if (!old) continue;
        const plaintext = await decryptEnvelope({
          kvKey,
          envelope: old,
          cryptoKey: input.oldCryptoKey,
        });
        const next = await encryptEnvelope({
          kvKey,
          plaintext,
          cryptoKey: this.cryptoKey,
        });
        await this.store.setItem(kvKey, next);
        this.cache.delete(this.cacheKey(this.parseKey(kvKey)));
        rekeyed.push(kvKey);
      } catch (cause) {
        failures[kvKey] = (cause as Error).message;
      }
    }
    return { rekeyed, failures };
  }

  /** List secret identities, optionally scoped to one namespace. */
  async list(namespace?: string): Promise<SecretRef[]> {
    const prefix = namespace ? `${KEY_PREFIX}${namespace}:` : KEY_PREFIX;
    const keys = await this.store.getKeys(prefix);
    return keys.map((name) => this.parseKey(name));
  }

  /** Delete a secret, evicting it from the local cache. */
  async delete(input: SecretRef): Promise<void> {
    await this.store.removeItem(this.key(input));
    this.cache.delete(this.cacheKey(input));
  }
}
