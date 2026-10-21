import { WorkerEntrypoint } from "cloudflare:workers";
import Gateway, { GatewayAuthority, RustInitialControlInstaller } from "./build/index.js";

export { GatewayAuthority };
export default Gateway;

export class InitialControlInstaller extends WorkerEntrypoint {
  describeTarget() {
    const installer = new RustInitialControlInstaller(this.env);
    try {
      return installer.describeTarget();
    } finally {
      installer.free();
    }
  }

  async installInitialControlOwner(input) {
    const installer = new RustInitialControlInstaller(this.env);
    try {
      return await installer.installInitialControlOwner(input);
    } finally {
      installer.free();
    }
  }
}
