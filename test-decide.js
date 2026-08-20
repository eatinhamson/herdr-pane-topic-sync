#!/usr/bin/env bun
// Self-check for decide()'s pin/refresh logic. Run: bun test-decide.js
import assert from "node:assert";
import { decide } from "./sync-labels.js";

// Fresh id, nothing there yet -> safe to write the auto label.
assert.deepStrictEqual(decide(undefined, undefined, "wanted"), { label: "wanted", pinned: false, write: true });

// Fresh id, but something already has a label we've never written -> adopt
// it as a pinned baseline instead of clobbering unknown provenance.
assert.deepStrictEqual(decide(undefined, "pre-existing", "wanted"), { label: "pre-existing", pinned: true, write: false });

// Untouched, topic changed -> auto-refresh.
assert.deepStrictEqual(
  decide({ label: "old-topic", pinned: false }, "old-topic", "new-topic"),
  { label: "new-topic", pinned: false, write: true },
);

// Untouched, topic unchanged -> no-op.
assert.deepStrictEqual(
  decide({ label: "same", pinned: false }, "same", "same"),
  { label: "same", pinned: false, write: false },
);

// Renamed by hand -> pins, does not write.
assert.deepStrictEqual(
  decide({ label: "old-topic", pinned: false }, "My Custom Name", "new-topic"),
  { label: "My Custom Name", pinned: true, write: false },
);

// Pinned, topic drifts further on later ticks -> stays pinned (this is the
// bug the first cut of this logic had: comparing against `wanted` every
// tick reverted the pin on the very next sync since a hand-typed name
// almost never matches the live topic).
assert.deepStrictEqual(
  decide({ label: "My Custom Name", pinned: true }, "My Custom Name", "yet-another-topic"),
  { label: "My Custom Name", pinned: true, write: false },
);

// Pinned, human retypes it to exactly the current auto label -> unpins.
assert.deepStrictEqual(
  decide({ label: "My Custom Name", pinned: true }, "current-topic", "current-topic"),
  { label: "current-topic", pinned: false, write: false },
);

// Pinned, human renames it again to something else -> stays pinned, new value.
assert.deepStrictEqual(
  decide({ label: "My Custom Name", pinned: true }, "Another Name", "current-topic"),
  { label: "Another Name", pinned: true, write: false },
);

// Old (pre-pin-tracking) state file stored a bare string -> migrates as unpinned.
assert.deepStrictEqual(decide("old-topic", "old-topic", "new-topic"), { label: "new-topic", pinned: false, write: true });

console.log("decide(): all cases pass");
