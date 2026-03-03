import { createTestDb, runSetupScript } from "./db.ts";

await createTestDb();
await runSetupScript();
