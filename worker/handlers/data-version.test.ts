import { describeDataVersionConformance } from "../../src/data/data-version-conformance"
import { createTestSqlDriver } from "./sqlite-test-driver"

// The corpus Durable Object's engine side of the data-version transform: the
// DO constructor runs the same `ensureCorpusSchema → ensureDataVersion` path
// (worker/corpus-do.ts), exercised here on the worker test engine — the same
// stand-in the rest of the worker corpus suites use. (The live DO path itself
// runs in scripts/replica-e2e.ts.)
describeDataVersionConformance("the worker corpus test driver", createTestSqlDriver)
