/**
 * Creates the CFO's policy-signing key (P-256), separate from the supplier's Metal issuer key.
 * Writes keys/cfo-policy.json (private, git-ignored) and keys/cfo-policy.public.json. Refuses to overwrite.
 *   npx tsx scripts/create-policy-key.ts
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { NORTHWIND } from "../src/desk/northwind.js";

const { key, pub } = NORTHWIND.cfoPolicyKey;
if (existsSync(key)) throw new Error(`${key} exists: not overwriting`);
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" });
const kid = createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest("base64url");
writeFileSync(key, JSON.stringify({ kid, privateJwk: privateKey.export({ format: "jwk" }) }), { mode: 0o600 });
writeFileSync(pub, JSON.stringify({ kid, jwk }));
console.log(`CFO policy key ${kid.slice(0, 12)}… written to ${key} (private) and ${pub}`);
