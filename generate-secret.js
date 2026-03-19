/**
 * generate-secret.js
 * Run this once to generate your JWT_SECRET and a strong password.
 * Then copy the output into your .env file.
 *
 * Usage:  node generate-secret.js
 */

const crypto = require("crypto");

const jwtSecret = crypto.randomBytes(64).toString("hex");
const suggestedPassword = crypto.randomBytes(24).toString("base64url");

console.log("\n✅  Copy these into your .env file:\n");
console.log(`JWT_SECRET=${jwtSecret}`);
console.log(`API_PASSWORD=${suggestedPassword}`);
console.log("\n⚠️  Keep these secret. Never commit them to git.\n");
