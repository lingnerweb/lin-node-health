import { createHash, timingSafeEqual } from "node:crypto";

const BEARER = /^Bearer\s+(.+)$/i;

/**
 * Authorization and X-Authorization. The second one is required: hosts behind
 * basic auth consume the first, so Prometheus sends the token as
 * X-Authorization.
 */
export const TOKEN_HEADERS = ["authorization", "x-authorization"] as const;

/** Every bearer token the request carries, in header order. */
export function readBearerTokens(headers: Headers): string[] {
	const tokens: string[] = [];
	for (const name of TOKEN_HEADERS) {
		const value = headers.get(name);
		const match = value === null ? null : BEARER.exec(value);
		if (match?.[1] !== undefined) {
			tokens.push(match[1].trim());
		}
	}
	return tokens;
}

/**
 * Constant time over the token: both sides are hashed first, so the comparison
 * runs over 32 bytes regardless of the presented length and no length leaks.
 */
export function verifyToken(presented: string, expected: string): boolean {
	if (expected === "") {
		return false;
	}
	return timingSafeEqual(sha256(presented), sha256(expected));
}

function sha256(value: string): Buffer {
	return createHash("sha256").update(value, "utf8").digest();
}
