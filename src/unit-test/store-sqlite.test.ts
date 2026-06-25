import { runStoreContract } from "./store-contract";
import { SqliteStore } from "../backbone/store/sqlite-store";

runStoreContract("sqlite", () => new SqliteStore(":memory:"));
