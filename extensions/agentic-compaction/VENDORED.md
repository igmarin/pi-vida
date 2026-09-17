Vendored from https://github.com/laulauland/pi-agentic-compaction @ da1da580e6891d054c5ace464e8a4069cdc9d21a (package.json 0.4.0, no tags/releases upstream)
License: MIT (see LICENSE in this directory)
Refresh: re-copy index.ts from that repo as agentic-compaction.ts; keep this file and LICENSE in sync.
Local adaptations: import scopes rewritten (@mariozechner/* → @earendil-works/*, complete via pi-ai/compat, @sinclair/typebox → typebox); ctx.ui.notify guarded for headless mode; see issues #115-#118.
