// Loaded before the program. Defense in depth; not a hostile-code sandbox.
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";
const deny = () => {
  throw new Error("OFFLINE_NETWORK_FORBIDDEN");
};
globalThis.fetch = deny;
globalThis.WebSocket = class {
  constructor() {
    deny();
  }
};
net.connect = net.createConnection = deny;
net.Socket.prototype.connect = deny;
net.Server.prototype.listen = deny;
tls.connect = deny;
dgram.createSocket = deny;
for (const key of ["lookup", "resolve", "resolve4", "resolve6", "reverse"]) {
  dns[key] = deny;
  dns.promises[key] = deny;
}
syncBuiltinESMExports();
