/**
 * Plugin entry: `export default { id, setup }` — the plain object form task 02 proved the loader
 * accepts, with no runtime import of `@opencode/plugin` (it is a types-only devDependency).
 *
 * This is what the package's `./server` export points at, so `.opencode/plugins/*.ts` can load it
 * either as `import entry from "fast-opencode-compaction/server"` or by re-export.
 */

import { setup } from "./plugin.js";

export default { id: "fast-opencode-compaction", setup };
