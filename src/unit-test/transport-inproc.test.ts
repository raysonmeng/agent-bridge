import { runTransportContract } from "./transport-contract";
import { InProcTransport } from "../backbone/transport/inproc-transport";

runTransportContract("inproc", () => new InProcTransport());
