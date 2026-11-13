// The engine and @solana/web3.js expect Node's Buffer. Imported first by every entry point.
import { Buffer } from "buffer";

const g = globalThis as unknown as { Buffer?: typeof Buffer };
if (!g.Buffer) g.Buffer = Buffer;
