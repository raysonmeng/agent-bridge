import { runStoreContract } from "./store-contract";
import { InMemoryStore } from "../backbone/store/memory-store";

runStoreContract("memory", () => new InMemoryStore());
