import { loadEnvFile } from "./load-env";

// Side-effect module: hydrate process.env from the repo-root `.env` at import
// time. server.ts imports this FIRST so `.env` is applied before any other
// module (e.g. lib/db, which resolves DB_PATH at import) reads process.env.
// "Real env wins", so the supervisor's inline vars still take precedence.
loadEnvFile(process.cwd());
